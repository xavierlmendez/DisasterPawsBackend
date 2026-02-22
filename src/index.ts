import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

dotenv.config();
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(helmet);

type IncidentStatus =
  | 'draft'
  | 'needs_human_review'
  | 'approved'
  | 'rejected'
  | 'executed';

type ApprovalDecision = 'approve' | 'reject';

type Incident = {
  id: string;
  createdAt: string;
  updatedAt: string;
  report: string;
  location: string;
  suggestedPriority: 'P1' | 'P2' | 'P3';
  confidence: number;
  finalPriority?: 'P1' | 'P2' | 'P3';
  status: IncidentStatus;
  reviewReason?: string;
  reviewedBy?: string;
};

type ApprovalEvent = {
  id: string;
  incidentId: string;
  from: IncidentStatus;
  to: IncidentStatus;
  actor: string;
  reason?: string;
  createdAt: string;
};

const incidents = new Map<string, Incident>();
const approvalEvents: ApprovalEvent[] = [];

const transitions: Record<IncidentStatus, IncidentStatus[]> = {
  draft: ['needs_human_review'],
  needs_human_review: ['approved', 'rejected'],
  approved: ['executed'],
  rejected: ['needs_human_review'],
  executed: []
};

function canTransition(from: IncidentStatus, to: IncidentStatus) {
  return transitions[from].includes(to);
}

function triage(report: string, urgencyHint?: 'low' | 'medium' | 'high') {
  let score = 0.5;
  if (/injur|bleed|stuck|flood|fire|heat|cold/i.test(report)) score += 0.25;
  if (urgencyHint === 'high') score += 0.2;
  if (urgencyHint === 'low') score -= 0.2;
  score = Math.max(0, Math.min(1, score));

  const suggestedPriority = score > 0.75 ? 'P1' : score > 0.55 ? 'P2' : 'P3';
  return { suggestedPriority, confidence: Number(score.toFixed(2)) } as const;
}

function transitionIncident(
  incident: Incident,
  to: IncidentStatus,
  actor: string,
  reason?: string
) {
  if (!canTransition(incident.status, to)) {
    throw new Error(`Invalid transition: ${incident.status} -> ${to}`);
  }

  const now = new Date().toISOString();
  const event: ApprovalEvent = {
    id: randomUUID(),
    incidentId: incident.id,
    from: incident.status,
    to,
    actor,
    reason,
    createdAt: now
  };

  incident.status = to;
  incident.updatedAt = now;
  approvalEvents.push(event);
  return event;
}

app.get('/health', async () => ({ ok: true, service: 'disasterpaws-backend' }));

app.post('/triage/score', async (req, reply) => {
  const schema = z.object({
    report: z.string().min(10),
    location: z.string().min(2),
    urgencyHint: z.enum(['low', 'medium', 'high']).optional()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const { report, urgencyHint } = parsed.data;
  const { suggestedPriority, confidence } = triage(report, urgencyHint);

  return { suggestedPriority, confidence, requiresHumanApproval: true };
});

app.post('/incidents', async (req, reply) => {
  const schema = z.object({
    report: z.string().min(10),
    location: z.string().min(2),
    urgencyHint: z.enum(['low', 'medium', 'high']).optional(),
    actor: z.string().min(2).default('system')
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const { report, location, urgencyHint, actor } = parsed.data;
  const { suggestedPriority, confidence } = triage(report, urgencyHint);

  const now = new Date().toISOString();
  const incident: Incident = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    report,
    location,
    suggestedPriority,
    confidence,
    status: 'draft'
  };

  incidents.set(incident.id, incident);
  transitionIncident(incident, 'needs_human_review', actor, 'Auto-routed for HITL review');

  return reply.code(201).send(incident);
});

app.get('/incidents', async (req) => {
  const querySchema = z.object({
    status: z
      .enum(['draft', 'needs_human_review', 'approved', 'rejected', 'executed'])
      .optional()
  });
  const parsed = querySchema.safeParse(req.query ?? {});
  const all = Array.from(incidents.values());
  if (!parsed.success || !parsed.data.status) return all;
  return all.filter((i) => i.status === parsed.data.status);
});

app.get('/incidents/:id', async (req, reply) => {
  const params = z.object({ id: z.string() }).safeParse(req.params);
  if (!params.success) return reply.code(400).send({ error: 'Invalid incident id' });

  const incident = incidents.get(params.data.id);
  if (!incident) return reply.code(404).send({ error: 'Incident not found' });

  const events = approvalEvents.filter((e) => e.incidentId === incident.id);
  return { incident, events };
});

app.post('/incidents/:id/review', async (req, reply) => {
  const params = z.object({ id: z.string() }).safeParse(req.params);
  if (!params.success) return reply.code(400).send({ error: 'Invalid incident id' });

  const bodySchema = z.object({
    decision: z.enum(['approve', 'reject']),
    actor: z.string().min(2),
    reason: z.string().min(3),
    finalPriority: z.enum(['P1', 'P2', 'P3']).optional()
  });

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const incident = incidents.get(params.data.id);
  if (!incident) return reply.code(404).send({ error: 'Incident not found' });

  const { decision, actor, reason, finalPriority } = parsed.data;
  const targetStatus: IncidentStatus = decision === 'approve' ? 'approved' : 'rejected';

  try {
    if (decision === 'approve') {
      incident.finalPriority = finalPriority ?? incident.suggestedPriority;
    }
    incident.reviewReason = reason;
    incident.reviewedBy = actor;

    const event = transitionIncident(incident, targetStatus, actor, reason);
    return { incident, event };
  } catch (error) {
    return reply.code(409).send({
      error: error instanceof Error ? error.message : 'Invalid state transition'
    });
  }
});

app.post('/incidents/:id/reopen', async (req, reply) => {
  const params = z.object({ id: z.string() }).safeParse(req.params);
  if (!params.success) return reply.code(400).send({ error: 'Invalid incident id' });

  const body = z
    .object({ actor: z.string().min(2), reason: z.string().min(3) })
    .safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const incident = incidents.get(params.data.id);
  if (!incident) return reply.code(404).send({ error: 'Incident not found' });

  try {
    const event = transitionIncident(
      incident,
      'needs_human_review',
      body.data.actor,
      body.data.reason
    );
    return { incident, event };
  } catch (error) {
    return reply.code(409).send({
      error: error instanceof Error ? error.message : 'Invalid state transition'
    });
  }
});

app.post('/incidents/:id/execute', async (req, reply) => {
  const params = z.object({ id: z.string() }).safeParse(req.params);
  if (!params.success) return reply.code(400).send({ error: 'Invalid incident id' });

  const body = z.object({ actor: z.string().min(2) }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

  const incident = incidents.get(params.data.id);
  if (!incident) return reply.code(404).send({ error: 'Incident not found' });

  try {
    const event = transitionIncident(incident, 'executed', body.data.actor, 'Dispatch executed');
    return { incident, event };
  } catch (error) {
    return reply.code(409).send({
      error: error instanceof Error ? error.message : 'Invalid state transition'
    });
  }
});

const port = Number(process.env.PORT || 4000);
await app.listen({ port, host: '0.0.0.0' });
