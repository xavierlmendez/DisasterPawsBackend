import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(helmet);

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
  let score = 0.5;
  if (/injur|bleed|stuck|flood|fire|heat|cold/i.test(report)) score += 0.25;
  if (urgencyHint === 'high') score += 0.2;
  if (urgencyHint === 'low') score -= 0.2;
  score = Math.max(0, Math.min(1, score));

  return {
    suggestedPriority: score > 0.75 ? 'P1' : score > 0.55 ? 'P2' : 'P3',
    confidence: Number(score.toFixed(2)),
    requiresHumanApproval: true
  };
});

const port = Number(process.env.PORT || 4000);
await app.listen({ port, host: '0.0.0.0' });
