# DisasterPaws Backend

Fastify + TypeScript + Prisma backend for HITL DisasterPaws workflows.

## Scripts
- npm run dev
- npm run build
- npm start

## Endpoints
- GET /health
- POST /triage/score (returns suggested priority + confidence, always requires human approval)

## Env
Copy `.env.example` to `.env`.
