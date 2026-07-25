# Health Check Scheduler

A lightweight, local-first web prototype that collects a symptom description,
asks focused follow-up questions, suggests a specialist, and creates a
browser-local demo appointment.

The application works without a symptom CSV, model, API key, database, or
external scheduling service. Its deterministic router, fictional specialist
catalog, and generated availability remain the complete fallback application.
They are test data, not medically validated guidance.

## Run locally

Requirements: Node.js 22 or newer and pnpm.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000`.

To enable optional LLM enhancement, copy `.env.example` to `.env.local`, choose
a mode, and add a Hugging Face access token only when the selected mode needs
one. Never commit `.env.local`.

## Conversation modes

| `CHAT_MODE` | Behavior |
| --- | --- |
| `local` | Never calls a model. Uses the self-contained safety checks, follow-up flow, and synthetic specialty router. |
| `hybrid` | Requests an LLM enhancement when configured, then safely falls back to the complete local flow for missing credentials, timeouts, invalid output, low confidence, or provider errors. |
| `llm-required` | Requires a working model configuration and returns a non-success enhancement response for model failures. Use this mode for integration validation, not offline use. |

Hybrid and LLM-required modes use the OpenAI-compatible Hugging Face Inference
Providers endpoint at `https://router.huggingface.co/v1`. Configure
`HF_CHAT_MODEL` with a chat-capable model available to your Hugging Face account;
the placeholder in `.env.example` is intentionally not a pinned production
choice.

The model may extract structured symptom facts, select the next approved
question type, and propose one specialty from the application allowlist. It
cannot bypass deterministic urgent-warning checks, diagnose, create
appointments, or invent specialist IDs.

## Privacy boundary

Uploaded TXT, Markdown, JSON, or CSV files are parsed locally. Raw file bytes,
complete file contents, and unapproved extractions are not sent to the model.
When model enhancement is enabled, only the recent chat messages and structured
context evidence explicitly approved by the user cross the server boundary;
approved evidence can include a short supporting phrase from the source file.
Provider retention and regional-processing terms still apply to submitted
content.

## Verify

Normal tests never call a real model provider.

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Deploy to Vercel

The project is a standard Next.js application and its model adapter runs in a
Vercel Function; it does not require a writable filesystem. Import the
repository into Vercel and add the same environment variables from
`.env.example` in Project Settings. Use `CHAT_MODE=local` for a zero-secret
deployment or `CHAT_MODE=hybrid` with `HF_TOKEN` and `HF_CHAT_MODEL` for enhanced
conversations. The browser-local appointment remains a demonstration and does
not contact a clinic.

## Prototype capabilities

- Conversational symptom intake with bounded follow-up questions
- Deterministic urgent-warning stop before routine scheduling
- Optional, schema-validated LLM conversation enhancement
- Replaceable synthetic, future CSV, or pretrained-model routing adapters
- Primary care fallback for unmatched concerns
- Specialty-aware fictional locations, visit durations, and generated slots
- Browser-local conversation and appointment persistence
- Local confirmation code with no clinic or email side effects

See [project-plan.md](./project-plan.md) for the architecture and safety
boundaries.
