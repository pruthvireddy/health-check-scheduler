# Health Check Scheduler

A lightweight, local-first prototype that collects a symptom description, asks
two follow-up questions, recommends a specialist from a small synthetic catalog,
and creates a browser-local demo appointment.

The default application is fully self-contained. It does not require a symptom
CSV, pretrained model, LLM, database, API key, or external scheduling service.
The seeded mappings and availability are fictional test data and are not
medically validated.

## Run locally

Requirements: Node.js 20.9 or newer and pnpm.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`.

## Verify

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Prototype capabilities

- Conversational symptom intake and two follow-up questions
- Deterministic urgent-warning stop before routine scheduling
- Optional local TXT, Markdown, JSON, or CSV context extraction with explicit
  user approval; raw file text is never persisted
- Replaceable `SpecialtyRouter` boundary with a synthetic rules adapter today
- Primary care fallback for unmatched concerns
- Specialty-aware fictional locations, visit durations, and generated slots
- Browser-local conversation and appointment persistence
- Local confirmation code with no clinic or email side effects

See [project-plan.md](./project-plan.md) for the architecture, safety boundaries,
and future CSV-backed and pretrained-model router options.
