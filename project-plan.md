# Health Check Scheduler — Architecture and Delivery Plan

## 1. Summary

Build a lightweight, self-contained chatbot web application that:

1. Collects the user’s symptoms in conversational language.
2. Checks for urgent warning signs before routine scheduling.
3. Optionally incorporates user-uploaded symptom-history material after showing the extracted context for review.
4. Asks two to four relevant follow-up questions.
5. Routes symptoms through a replaceable routing interface, using a small synthetic in-code catalog initially and allowing either validated CSV knowledge or a pretrained classifier later.
6. Recommends one suitable specialist or subspecialist with a brief, evidence-linked explanation.
7. Guides the user through location, duration, date, and time selection using controls embedded in the conversation.
8. Creates a browser-local appointment with a confirmation code and summary.

The first release is a safe demonstration, not a diagnostic product or production medical system. It will run locally and deploy as a single Vercel project without requiring a database.

The deterministic conversation, document-processing, safety, scheduling, and confirmation modules form the complete application. The initial router uses a deliberately small synthetic fixture, so no production mapping dataset, CSV file, model credential, or external service is required to build and test the full workflow. Later, a CSV-backed router or pretrained-model router can replace the fixture without changing the conversation or scheduling layers.

An optional hosted LLM adapter may improve natural-language extraction, choose a curated follow-up question, and propose an allowlisted specialty. It is accessed through a small Vercel server function and remains subordinate to deterministic validation. Neither an enhancement model nor a future dedicated routing model can own emergency safety decisions, workflow state, scheduling, or appointment confirmation.

### Current implementation status — July 24, 2026

Implemented and verified:

- Complete browser-local symptom, urgent-screening, follow-up, synthetic specialty-routing, scheduling, and confirmation flow.
- Local context upload and review for TXT, Markdown, JSON, and CSV; PDF is currently rejected with a clear text-export alternative.
- Optional Hugging Face conversation enhancement through the Vercel-compatible `/api/chat` route.
- `local`, `hybrid`, and `llm-required` execution modes with a visible per-turn status.
- Model request minimization, server-side validation, allowlists, confidence threshold, timeout, and deterministic fallback.
- Automated contract, parser, API, safety, routing, scheduling, persistence, and component coverage.
- Successful TypeScript check, automated test suite, production build, and no-token API smoke test.

Still intentionally deferred:

- Selecting and validating a production hosted model with a real provider token.
- A medically reviewed CSV mapping pack or dedicated pretrained routing model.
- Real clinic inventory, durable appointments, identity, notifications, compliance, and EHR/calendar integration.

## 2. Proposed Architecture

### Application stack

- Next.js with the App Router and TypeScript.
- React for the compact chat interface and inline scheduling widgets.
- Lightweight global CSS for responsive styling without a UI framework dependency.
- Zod schemas for API, triage, catalog, context evidence, routing results, optional CSV mappings, and appointment validation.
- Vitest and React Testing Library for unit and component tests.
- Playwright for the complete chat-to-confirmation flow.
- An optional Vercel-compatible `/api/chat` serverless route used only for bounded conversation enhancement.
- Browser `localStorage` for conversations and appointments.
- Browser IndexedDB for approved extracted context and, when enabled later, validated mapping packs.
- Client-side parsing for CSV, text, Markdown, JSON, and PDF context files.
- Small static TypeScript or JSON fixtures for synthetic symptom routing, specialists, locations, follow-up questions, and availability.

The repository will contain three main architectural areas:

- `src/app/`: Chat page, optional enhancement route, layout, and styling.
- `src/components/`: Transcript, composer, context upload, optional mapping management, inline selection controls, recommendation, urgent-warning, and confirmation cards.
- `src/lib/`: Framework-independent core modules, replaceable routing adapters, optional knowledge ingestion, conversation enhancement, scheduling, seeded catalogs, and browser persistence.

### Modular design

The application will use a ports-and-adapters boundary so that the domain workflow never imports an LLM SDK or depends on a network response:

```text
Chat and scheduling UI
          │
          ▼
Conversation application service
  ├─ Workflow state machine
  ├─ Safety policy
  ├─ Context evidence store
  ├─ Routing and follow-up engine
  └─ Scheduling engine
          │
          ├─ ConversationEnhancer port
          │    ├─ Deterministic enhancer (default)
          │    └─ LLM enhancer (optional)
          │
          ├─ ContextExtractor port
          │    ├─ Local text/CSV/JSON extractor
          │    ├─ Local PDF extractor
          │    └─ LLM-assisted extractor (optional)
          │
          ├─ RoutingKnowledgeRepository port
               ├─ Synthetic fixture repository (initial)
               └─ Validated browser-local CSV repository (optional)
          │
          └─ SpecialtyRouter port
               ├─ Synthetic rules router (initial/default)
               ├─ CSV rules router (future option)
               └─ Pretrained-model router (future option)
```

The synthetic adapters are the initial implementations and must support every state in the end-to-end workflow. Optional routing adapters return the same validated result shape and cannot add new workflow capabilities or bypass safety policy.

Conversation enhancement and specialty routing are two orthogonal configuration choices:

- Conversation mode is `local` for browser-only behavior, `hybrid` for model enhancement with deterministic fallback, or `llm-required` for integration testing where provider failure is surfaced rather than hidden.
- Routing backend is `synthetic` initially, with `csv` and `pretrained_model` reserved as interchangeable future implementations.

The default production-safe profile is `hybrid + synthetic`: it uses model enhancement only when server credentials are available and otherwise completes the identical workflow locally. Explicit `local + synthetic` mode makes no model request. Both profiles must run when no CSV files, routing-model artifacts, or browser-visible credentials exist. Later routing decisions can change independently of conversation enhancement. The interface exposes whether the latest turn used AI assistance or local rules.

### Runtime topology

```text
Browser
  ├─ Chat transcript and embedded scheduling controls
  ├─ Conversation state
  ├─ Local context extraction and review
  ├─ Selected specialty router
  │    ├─ Synthetic fixture (initial)
  │    ├─ CSV knowledge (optional)
  │    └─ Pretrained classifier (optional)
  ├─ Seeded schedule catalog
  ├─ Availability calculation
  └─ Local conversations and appointments
             │
             ├──────── Deterministic mode ends here
             │
             └──────── Optional enhanced mode
                              │
                              ▼
                    Next.js /api/chat route
                      ├─ Request validation
                      ├─ Second deterministic urgent screen
                      ├─ Data-minimization gate
                      ├─ Timeout and schema enforcement
                      └─ Hugging Face OpenAI-compatible adapter
```

No database, authentication service, calendar service, email provider, or language-model provider is required for the MVP. When hybrid mode is enabled, the only additional runtime dependency is an external model provider called from the server route; the browser never receives the provider token.

## 3. Conversation and Triage Design

### State machine

The chatbot will use explicit states rather than inferring the current workflow from display text:

```text
welcome
→ collecting_symptoms
→ urgent_screening
→ asking_follow_ups
→ recommending_specialist
→ selecting_location
→ selecting_duration
→ selecting_date
→ selecting_time
→ reviewing_appointment
→ confirmed
```

Additional terminal or recovery states:

- `urgent_exit`: Routine scheduling is stopped.
- `unsupported`: Symptoms cannot be safely routed within the curated catalog.
- `error_recovery`: Model, validation, or browser-storage failure.
- `cancelled`: The user cancels or restarts the flow.

Only transitions defined by the state machine will be accepted. The model may suggest content, but it cannot skip urgent screening, invent specialists, create availability, or confirm appointments.

### Symptom intake

The initial prompt will request:

- The main symptom or concern.
- Where it is occurring.
- How long it has been present.
- Its approximate severity.

The user can answer naturally rather than completing a medical form. The deterministic extractor will normalize common symptom terms, body areas, durations, severity phrases, negation, and simple synonyms. It will retain the original text in the local conversation and attach provenance to every extracted fact.

At any point during symptom collection, the user may attach supporting material. Extracted facts from an attachment remain separate from current self-reported symptoms until the user reviews and approves them.

The system will ask two to four follow-up questions, stopping once it has sufficient information for a routing recommendation. Follow-ups may cover:

- Onset and duration.
- Severity and progression.
- Associated symptoms.
- Relevant context such as injury or recurrence.

It will avoid requesting full medical histories, insurance details, government identifiers, or unnecessary sensitive information.

### Safety layer

A deterministic safety check will run after every user response, before routing, and before any optional enhancement request. It will recognize a curated set of emergency warning-sign categories, including:

- Severe breathing difficulty.
- Symptoms suggestive of stroke.
- Severe or persistent chest pain.
- Loss of consciousness or acute confusion.
- Uncontrolled bleeding.
- Severe allergic reaction.
- Immediate self-harm risk.
- Other explicitly curated emergency patterns.

If triggered, the application will:

- Move to `urgent_exit`.
- Display a prominent instruction to seek immediate emergency care.
- Explain that the chatbot cannot safely continue routine scheduling.
- Disable specialist recommendation and appointment controls.
- Allow only starting a new conversation.

The MVP will not attempt diagnosis, calculate clinical risk scores, or claim that the absence of a detected red flag means the situation is safe.

Uploaded historical material will not automatically trigger an emergency exit because it may describe an old event. If the extractor finds a red-flag phrase in uploaded material, the chatbot will ask whether that symptom is happening now. A current confirmation runs through the normal safety policy; a historical confirmation remains contextual evidence only.

### Specialist routing

The first coding milestone will use a deliberately small synthetic fixture containing:

- Primary care.
- Cardiology.
- Dermatology.
- Gastroenterology.
- Neurology.
- Orthopedics.
- Otolaryngology/ENT.

It will include only enough fictional symptom phrases, follow-up questions, and confidence weights to exercise common routes, ambiguity, urgent exits, the primary-care fallback, and the complete scheduling flow. This fixture is test data, not a medically validated knowledge base.

The stable specialist allowlist and interfaces will permit later expansion to:

- Endocrinology.
- Pulmonology.
- Allergy and immunology.
- Urology.
- Gynecology.
- Behavioral health.
- Representative subspecialties such as sports medicine, headache neurology, cardiac electrophysiology, and interventional gastroenterology.

Each route will define:

- Recognized symptom terms, synonyms, and combinations.
- Evidence weights and negation behavior.
- Relevant follow-up question templates.
- Exclusion and escalation conditions.
- Minimum information required.
- Allowed specialty or subspecialty result.
- User-facing rationale template.
- Supported appointment durations.
- Compatible locations.

Routing will score only allowlisted specialties. The engine will combine:

- Current symptoms stated in the conversation.
- User-approved facts extracted from uploaded historical material.
- Answers to deterministic follow-up questions.
- A validated result from the configured specialty router.

The synthetic router will use simple weighted rules stored in TypeScript or JSON. A future CSV router will use validated mapping rows, while a future pretrained-model router will use the same normalized evidence as model input. The safety policy always runs before routing and cannot be replaced or weakened by any backend. Conflicting, invalid, or low-confidence results produce a primary-care fallback.

Every backend must return the same output: ranked allowlisted candidates, normalized confidence, evidence references, source/version provenance, and no free-form diagnosis. The application selects one best-match specialty or subspecialty and generates a concise reason from user-provided facts. Low-confidence or unsupported cases fall back to primary care rather than inventing a precise referral.

## 4. Context Uploads and Optional Routing Sources

Patient context is an application feature. CSV mapping import and pretrained-model routing are optional future backends; neither is required for the initial build.

### Patient context upload

Users may attach past symptom notes, discharge summaries, visit summaries, or other contextual material in:

- Plain text (`.txt`).
- Markdown (`.md`).
- Structured text (`.json` or `.csv`).
- Text-based PDF (`.pdf`).

The first version will accept up to five files per conversation, up to 5 MB each, and up to 50,000 extracted characters in total. Image-only or scanned PDFs will be reported as unsupported; OCR is outside the MVP.

Processing will occur locally:

1. Validate the filename, declared type, detected type, size, and extraction limit.
2. Extract text in the browser.
3. Normalize likely symptom facts using the deterministic extractor.
4. Mark every fact with its source file and whether it appears current, historical, or uncertain.
5. Show an editable review card containing the extracted summary.
6. Ask the user to approve, edit, or discard the summary.
7. Add only approved facts to routing evidence.

Raw file bytes will remain in memory and will not be persisted. An approved extracted summary may be retained with the conversation only after the user chooses “Use this context.” The user can remove a source at any time; doing so removes its derived facts and recalculates the recommendation.

In enhanced mode, uploaded material will still be parsed locally first. The user must explicitly allow the approved, minimized text summary to be sent for model enhancement. Raw files will never be sent to the optional model provider.

### Symptom-to-specialty CSV mapping packs

If CSV routing is selected later, a mapping-management drawer will allow a user or demo administrator to import additional routing knowledge. The import flow will provide a downloadable template, validation preview, activation control, pack status, and delete action. This functionality is not part of the first coding milestone.

Each CSV row will use this schema:

```text
version,mapping_id,symptom_terms,specialty_id,subspecialty_id,weight,follow_up_question_ids,exclusion_terms,rationale_template,active
```

Field rules:

- `version`: Required supported schema version, initially `1`.
- `mapping_id`: Required unique stable identifier within the pack.
- `symptom_terms`: Required pipe-delimited normalized terms or phrases.
- `specialty_id`: Required identifier from the bundled specialist allowlist.
- `subspecialty_id`: Optional allowlisted subspecialty under the selected specialty.
- `weight`: Integer from 1 through 100.
- `follow_up_question_ids`: Optional pipe-delimited identifiers from the bundled question catalog.
- `exclusion_terms`: Optional pipe-delimited terms that suppress this row.
- `rationale_template`: Optional plain-text explanation with only documented placeholders.
- `active`: Boolean controlling whether the row participates in routing.

An imported mapping pack may add terms and evidence for existing specialties, but it cannot:

- Create a new specialty or subspecialty.
- Add executable content, HTML, or scripts.
- Modify emergency warning rules.
- Bypass required follow-up questions.
- Directly create appointments.
- Override an equal-scoring bundled mapping.

Before activation, the importer will:

- Parse CSV with quoted-field support and normalize headers.
- Validate every row and reject the complete pack if any blocking error exists.
- Detect duplicate identifiers, unknown specialty references, invalid weights, and unsupported placeholders.
- Show valid-row count, errors, warnings, referenced specialties, and likely conflicts.
- Require explicit activation after preview.

Validated active packs will be stored in browser IndexedDB with a checksum, schema version, source filename, imported timestamp, and active status. Removing or disabling a pack immediately recalculates subsequent routing. Existing confirmed appointments remain unchanged.

### Pretrained-model routing

If model routing is selected later, a `PretrainedModelSpecialtyRouter` adapter will accept only normalized symptom evidence and return the standard routing result. The model may run in the browser when its format and size permit, or behind a server endpoint when necessary; that deployment choice can be made later without changing the core contract.

The adapter must:

- Publish a model identifier, version, supported specialty IDs, and input-schema version.
- Return candidate specialty IDs from the existing allowlist with normalized confidence values.
- Reject unknown classes, malformed output, incompatible versions, and non-finite scores.
- Apply a configured confidence threshold and use primary care below that threshold.
- Preserve enough input and model-version provenance to reproduce a demo recommendation.
- Time out or fail closed to the synthetic router during development until the model backend is explicitly approved.
- Remain subordinate to deterministic emergency screening and workflow rules.

The pretrained routing model is separate from the optional conversational LLM. Either, both, or neither may be enabled.

### Knowledge precedence and provenance

The routing engine will retain evidence provenance so a result can be reproduced and explained:

1. Immutable emergency and workflow rules.
2. Current facts directly stated and confirmed by the user.
3. User-approved facts extracted from historical files.
4. The configured router’s validated result and source/version provenance.
5. Primary-care fallback when confidence remains insufficient.

Recommendations will record the selected backend, its version, and backend-specific provenance such as a synthetic fixture version, CSV pack checksums, or pretrained model version. When CSV packs are enabled, the UI will explain that they are unverified demo knowledge and provide a one-click path to disable them.

## 5. Deterministic Core and Optional Conversation Enhancement

### Deterministic application core

Application code will exclusively own and fully implement:

- Red-flag detection.
- Workflow state and valid transitions.
- Natural-language normalization for the supported symptom vocabulary.
- Local context extraction and fact review.
- Synthetic routing-fixture loading and provenance.
- Specialist and subspecialist allowlists.
- Routing-result validation and primary-care fallback.
- Maximum follow-up count.
- Complete user-facing messages and question templates.
- Scheduling constraints and availability.
- Appointment validation and confirmation.
- All fallback and recovery behavior.

This core must be usable directly from the browser application. It will expose framework-independent functions that accept validated state and return the next state, message content, structured action, and evidence. No call site in the core will assume that an LLM result will arrive later.

### Optional model responsibilities

When `hybrid` or `llm-required` mode is configured, the language model may:

- Summarize the user’s symptom description.
- Select the most useful next question from an allowed set.
- Map natural-language answers into structured fields.
- Suggest a permitted specialist for validation and comparison with the synthetic router.
- Generate a brief, natural acknowledgement that is screened before display.
- Provide a short, non-diagnostic explanation.

The browser runs urgent screening before an enhancement request, and the server repeats that screen before contacting the provider. The model response must conform to a validated structured schema containing:

- Zero or more normalized symptom-fact proposals.
- One proposed action: ask a follow-up, recommend a specialist, or request urgent review.
- An optional question type from the curated follow-up allowlist.
- An optional specialty identifier from the bundled allowlist.
- A normalized confidence value from zero through one.
- An optional short explanation with no diagnosis.

Invalid, unsupported, low-confidence, or timed-out model results are discarded and the deterministic path continues without losing the transcript. Model output is advisory: the application validates every proposed fact, question type, and specialist identifier before use. The model cannot create free-form question categories, new specialties, availability, appointments, or confirmation codes.

### Lightweight hosted-model implementation

The first enhancement adapter uses the Vercel AI SDK with its OpenAI-compatible provider against the Hugging Face inference router. This keeps model weights and inference outside the Vercel deployment while keeping the application bundle compact.

Server-only configuration:

```text
CHAT_MODE=hybrid
HF_TOKEN=<server-only secret>
HF_CHAT_MODEL=<OpenAI-compatible hosted model identifier>
HF_BASE_URL=https://router.huggingface.co/v1
LLM_TIMEOUT_MS=12000
LLM_MAX_OUTPUT_TOKENS=300
LLM_CONFIDENCE_THRESHOLD=0.70
```

The route sends at most eight recent user/assistant messages plus up to fifty approved, non-negated evidence items. Raw uploads, rejected extraction results, appointment details, and browser storage are never sent. Output length and duration are bounded to fit a short Vercel function request.

`CHAT_MODE` behavior:

- `local`: The browser skips `/api/chat` entirely; a direct API call also short-circuits without contacting Hugging Face.
- `hybrid`: Use Hugging Face when configured, otherwise return a structured fallback signal and continue locally.
- `llm-required`: Intended for integration validation; missing configuration or provider failure is returned as an unavailable response so deployment mistakes are visible.

Normal automated tests mock the enhancement boundary and never contact a real provider. A live-provider smoke test is optional and must use a separately configured test token.

### Fully self-contained mode

The `local + synthetic` profile is a first-class deployment, not a degraded fallback. In this mode:

- No chat or document content is sent to a server-side model route.
- Keyword normalization, decision tables, file extraction, and the small synthetic router run in the browser.
- Follow-up questions will come from specialty-specific templates.
- Routing will use the versioned synthetic fixture and weighted rules.
- Patient-context uploads, scheduling, persistence, and confirmation remain available.
- CSV mapping import becomes available only when that optional adapter is implemented and enabled.
- The initial acceptance suite will run with no CSV mapping files and no model environment variables.
- The interface will unobtrusively indicate “Local rules mode.”

Model credentials will be server-only environment variables and never included in the browser bundle.

## 6. Scheduling Flow

### Embedded chat controls

Scheduling remains inside the transcript. The assistant will render state-specific widgets instead of sending users to a separate page:

- Location selection cards.
- Appointment-duration chips.
- Date picker with selectable availability.
- Time-slot buttons.
- Appointment review card.
- Confirmation card.

The message composer will be enabled for conversational states and disabled when a structured selection is required, reducing ambiguous input.

### Selection order

After the recommendation:

1. The user accepts the recommended specialist.
2. The user selects a compatible location.
3. The user selects an offered appointment duration.
4. The user selects an available date.
5. The user selects an available time.
6. The user reviews the complete appointment.
7. The user confirms or goes back to revise a selection.

Changing an earlier choice clears all dependent later choices. For example, changing location clears duration, date, and time.

### Seeded availability

The catalog will contain fictional:

- Specialist and subspecialist profiles.
- Clinic locations.
- Weekly operating hours.
- Supported durations.
- Slot templates and blackout periods.

Availability will be generated for the next 30 days in the browser’s displayed timezone. Slot calculation will:

- Fit the full appointment duration within working hours.
- Exclude blackout periods.
- Exclude conflicting locally saved appointments.
- Reject past dates and times.
- Revalidate the slot immediately before confirmation.

Because storage is browser-local, conflict prevention applies only to appointments created in the same browser profile. The UI and documentation will identify appointments as demo reservations.

### Confirmation

A confirmed appointment will contain:

```ts
type Appointment = {
  id: string;
  confirmationCode: string;
  conversationId: string;
  patientDisplayName: string;
  contactEmail?: string;
  specialistId: string;
  locationId: string;
  durationMinutes: number;
  startsAt: string;
  timezone: string;
  status: "confirmed" | "cancelled";
  createdAt: string;
};
```

The generated confirmation code will use a human-readable format such as `HCS-7K4P92`. The confirmation card will display the specialist, location, date, time, duration, timezone, and code.

A display name will be required at confirmation. Email will be optional and stored only locally; the app will clearly state that no email is sent.

## 7. Core Interfaces and Data Contracts

The main domain contracts will include:

```ts
type ConversationStage =
  | "welcome"
  | "collecting_symptoms"
  | "reviewing_context"
  | "urgent_screening"
  | "asking_follow_ups"
  | "recommending_specialist"
  | "selecting_location"
  | "selecting_duration"
  | "selecting_date"
  | "selecting_time"
  | "reviewing_appointment"
  | "confirmed"
  | "urgent_exit"
  | "unsupported"
  | "error_recovery"
  | "cancelled";

type Recommendation = {
  specialtyId: string;
  subspecialtyId?: string;
  rationale: string;
  confidence: "high" | "medium" | "fallback";
  evidenceIds: string[];
  catalogVersion: string;
  routingSource: {
    backend: "synthetic" | "llm" | "csv" | "pretrained_model";
    version: string;
    provenanceIds: string[];
  };
};

type SymptomEvidence = {
  id: string;
  normalizedTerm: string;
  originalText: string;
  temporality: "current" | "historical" | "uncertain";
  source: "conversation" | "context_file";
  sourceLabel?: string;
  userApproved: boolean;
};

type SymptomSpecialtyMapping = {
  version: 1;
  mappingId: string;
  symptomTerms: string[];
  specialtyId: string;
  subspecialtyId?: string;
  weight: number;
  followUpQuestionIds: string[];
  exclusionTerms: string[];
  rationaleTemplate?: string;
  active: boolean;
};

type RoutingCandidate = {
  specialtyId: string;
  subspecialtyId?: string;
  confidence: number;
  evidenceIds: string[];
};

type RoutingResult = {
  backend: "synthetic" | "llm" | "csv" | "pretrained_model";
  version: string;
  candidates: RoutingCandidate[];
  provenanceIds: string[];
};

type ChatAction =
  | { type: "ask_follow_up"; questionId: string }
  | { type: "review_context"; evidence: SymptomEvidence[] }
  | { type: "show_recommendation"; recommendation: Recommendation }
  | { type: "show_urgent_guidance"; category: string }
  | { type: "start_scheduling"; specialtyId: string }
  | { type: "recoverable_error"; message: string };
```

The conversation application service will accept the current state, latest user event, approved evidence, and selected router. It will return a promise so a later model-backed router can be introduced without changing callers; the initial synthetic implementation resolves locally and immediately.

- A display-safe assistant message.
- The next valid conversation stage.
- A typed UI action.
- Updated structured symptom facts.
- Optional recommendation information.
- Evidence and routing-backend provenance.
- The active conversation mode and routing backend.

The replaceable module contracts will include:

```ts
interface ConversationEnhancer {
  enhance(input: EnhancementInput): Promise<EnhancementSuggestion>;
}

interface ContextExtractor {
  extract(input: ContextFile): Promise<ExtractedContext>;
}

interface RoutingKnowledgeRepository {
  getSyntheticMappings(): SymptomSpecialtyMapping[];
  getActiveImportedMappings(): Promise<SymptomSpecialtyMapping[]>;
}

interface SpecialtyRouter {
  readonly backend: "synthetic" | "llm" | "csv" | "pretrained_model";
  route(input: RoutingInput): Promise<RoutingResult>;
}
```

`SyntheticSpecialtyRouter` will be the only required router for the first coding milestone. `CsvSpecialtyRouter` and `PretrainedModelSpecialtyRouter` will be separate adapters added behind the same interface if and when those approaches are selected.

The optional `/api/chat` endpoint will accept only the validated, minimized enhancement input and return a schema-validated suggestion or fallback signal. The primary chat workflow will not depend on this endpoint and will never wait indefinitely for it.

Appointment creation will remain client-side in the MVP because all catalog and persistence data are browser-local.

## 8. User Interface Structure

The application will use a single responsive screen:

- Small application header with title and “New conversation.”
- Scrollable transcript area.
- Compact assistant and user message bubbles.
- Attachment control for symptom-history material.
- Extracted-context review cards with source, temporality, edit, approve, and remove actions.
- An optional mapping-pack manager, added only if CSV routing is selected later.
- A development indicator for conversation mode and routing backend, such as “Local conversation · Synthetic router.”
- Inline structured controls attached to assistant messages.
- Sticky composer at the bottom.
- Persistent non-diagnostic disclaimer near the beginning of the flow.
- Clear progress labels during scheduling.
- Accessible confirmation and urgent-warning cards.

Desktop width will remain intentionally compact, while mobile will use the full viewport. Controls will support keyboard navigation, visible focus states, screen-reader labels, and sufficient color contrast. Status changes such as routing and confirmation will be announced through an accessible live region.

## 9. Local Persistence and Privacy

Use versioned browser-storage keys for:

- Current conversation.
- Recent demo conversations.
- Confirmed and cancelled appointments.
- Schema version and migration metadata.

Use a versioned IndexedDB store for:

- User-approved extracted context associated with a conversation.
- Routing-backend provenance needed to reproduce a recommendation.
- Validated mapping-pack metadata and normalized rows only if CSV routing is enabled later.

Persistence behavior will include:

- Runtime schema validation when loading stored data.
- Safe reset if stored data is corrupt or incompatible.
- A visible “Clear demo data” action.
- Separate controls to clear symptom context, appointments, optional mapping packs, or all local data.
- No persistence of raw uploaded file bytes.
- No secrets or model credentials in local storage.
- No full date of birth, insurance data, payment data, or medical record identifiers.
- A notice explaining that symptom text, approved extracts, optional imported mappings, and appointments remain on the current browser.

In deterministic mode, user text and extracted context do not leave the browser. In enhanced mode, only the minimum approved summary required for the next step may be sent to the configured provider. Each context-review card will disclose whether its approved summary is eligible for enhancement, and users can keep it local.

## 10. Error and Recovery Behavior

- Model timeout or API failure: Continue through deterministic mode without losing the transcript.
- Invalid model output: Reject it and use rule-based output.
- Missing CSV and missing routing-model assets: Start normally with the synthetic router.
- Invalid or unavailable selected routing backend: Fall back to the synthetic router and expose the fallback in development diagnostics.
- Pretrained-model timeout, incompatible version, unknown class, or invalid score: Reject the model result and use the synthetic router.
- Unsupported, oversized, encrypted, image-only, or unreadable context file: Reject that file with an actionable explanation while preserving other selections.
- Partial text-extraction failure: Show only successfully extracted text and require review before use.
- Historical urgent phrase: Ask whether the symptom is current before applying emergency behavior.
- Invalid mapping row: Reject activation of the whole pack and present row-level errors.
- Unknown specialty or question identifier: Mark the row invalid; never silently remap it.
- Duplicate or conflicting mapping: Show a preview warning and apply documented bundled-catalog tie precedence.
- IndexedDB unavailable: Keep mappings and context in memory for the current session and explain that they will not persist.
- Mapping pack removed after recommendation: Keep the existing transcript for audit context, invalidate an unaccepted recommendation, and rerun routing before scheduling.
- Unsupported symptom route: Recommend primary care and explain the catalog limitation.
- No available slots: Offer another duration or location without restarting triage.
- Slot invalidated before confirmation: Return to time selection with a clear explanation.
- Corrupt local storage: Preserve application usability and offer to clear invalid demo data.
- Browser storage unavailable: Allow the session to continue in memory and explain that confirmation will not persist.
- Refresh during scheduling: Restore the last validated state when storage is available.
- Duplicate confirmation action: Return the existing appointment rather than creating another one.

## 11. Testing and Acceptance Criteria

### Unit tests

- Every legal and illegal state-machine transition.
- Emergency phrase detection, including common wording variations.
- Current-versus-historical red-flag handling for uploaded context.
- Deterministic extraction of symptoms, negation, severity, duration, and temporality.
- Synthetic specialty scoring, tie-breaking, confidence fallback, and allowlist enforcement.
- The shared `SpecialtyRouter` contract and result validation.
- Combined routing input from conversation facts, approved file evidence, and follow-up answers.
- CSV parsing, schema, conflict, and security tests when the CSV adapter is implemented.
- Model version, class allowlist, confidence, timeout, and malformed-output tests when the pretrained-model adapter is implemented.
- Text, Markdown, JSON, CSV, and text-based PDF extraction limits.
- Removal of a context source and recalculation of its derived evidence.
- Maximum follow-up count.
- Duration-aware availability calculation.
- Timezone and daylight-saving boundaries.
- Appointment overlap detection.
- Storage validation and migration behavior.
- Invalid structured model responses.
- Full deterministic behavior when the enhancement endpoint and all model credentials are absent.
- Equivalence of core workflow transitions in deterministic and enhanced modes.

### Component tests

- Symptom entry and follow-up messages.
- Attachment, extraction review, editing, approval, and removal.
- Mapping-pack preview and management tests only when the CSV adapter is implemented.
- Execution-mode indicator and local-only context control.
- Inline location, duration, date, and time controls.
- Clearing dependent selections when an earlier choice changes.
- Recommendation explanation.
- Urgent-exit presentation and disabled scheduling.
- Appointment review and confirmation.
- Keyboard navigation and accessible status announcements.

### End-to-end scenarios

Initial-build scenarios:

1. Repository contains no symptom-to-specialty CSV and no routing-model artifact → application starts with the synthetic router.
2. Synthetic common symptom → follow-ups → specialist → completed booking.
3. Synthetic specific symptom → subspecialist → completed booking.
4. User uploads historical notes → reviews extracted facts → receives an evidence-linked synthetic recommendation.
5. Historical file mentions an urgent symptom → chatbot confirms whether it is current before emergency handling.
6. Ambiguous or unsupported symptoms → primary-care fallback.
7. Emergency warning sign in current input → immediate routine-flow termination.
8. No model dependency or credential → complete context, routing, scheduling, and confirmation experience.
9. No slots for chosen combination → successful alternate selection.
10. Page refresh during scheduling → restored workflow and approved context.
11. Confirmation → persisted appointment, routing provenance, and unique confirmation code.
12. Locally conflicting appointment → unavailable slot excluded.
13. Mobile viewport → usable chat, upload review, and scheduling controls.
14. Corrupt browser storage → safe recovery without a blank or broken application.

Conditional routing-adapter scenarios:

1. Valid CSV pack → CSV router produces a contract-valid result and records pack provenance.
2. Invalid or conflicting CSV pack → activation is blocked with actionable row-level errors.
3. Valid pretrained-model result → model router produces allowlisted candidates and model-version provenance.
4. Missing, timed-out, incompatible, or malformed model → routing falls back to the synthetic router.
5. Switching the configured router does not change safety, conversation-state, scheduling, or confirmation behavior.

Initial acceptance requires all initial-build scenarios to pass locally and in a Vercel preview with no CSV mapping file, routing-model artifact, model endpoint, provider token, or model environment variable. The server-only AI SDK may remain installed but is not invoked in local mode. Conditional scenarios become required only when their adapter is implemented.

## 12. Delivery Phases

### Phase 1 — Foundation

- Initialize Next.js, TypeScript, styling, validation, and test tooling.
- Establish domain types and the explicit conversation state machine.
- Define the ports for conversation enhancement, context extraction, routing knowledge, and specialty routing.
- Add the responsive single-screen chat shell.
- Add a small versioned synthetic routing fixture plus fictional specialty, location, duration, and availability data.

### Phase 2 — Complete deterministic application

- Implement symptom normalization, urgent screening, follow-up templates, and `SyntheticSpecialtyRouter`.
- Build the full rules-only conversational path.
- Add inline scheduling controls and availability calculation.
- Add browser persistence and confirmation generation.
- Prove the full application flow with no CSV routing data, model artifact, endpoint, key, or model network request.

### Phase 3 — Patient-context extensibility

- Add local parsers and review UI for text, Markdown, JSON, CSV, and text-based PDF context.
- Add evidence provenance, temporality confirmation, and context removal/recalculation.

### Phase 4 — Optional routing backends

- Decide whether the next routing source is CSV knowledge, a pretrained classifier, or both.
- For CSV, add the mapping schema, template, validator, preview, activation, repository, and `CsvSpecialtyRouter`.
- For a pretrained classifier, add model loading or endpoint integration, result validation, version provenance, thresholds, and `PretrainedModelSpecialtyRouter`.
- Run the shared routing contract and fallback suite against each implemented adapter.

### Phase 5 — Optional conversation enhancement

- Add the server-side model adapter and structured response schema.
- Constrain conversational suggestions to the curated question and specialist catalogs.
- Implement explicit context consent, minimization, timeout, validation, and deterministic fallback behavior.
- Add minimal-context handling and secret-safe configuration.

### Phase 6 — Safety and quality

- Add disclaimers, urgent-exit behavior, accessibility refinements, and privacy messaging.
- Complete unit, component, and end-to-end coverage.
- Validate responsive behavior and keyboard-only operation.
- Verify local production builds and Vercel serverless compatibility.

### Phase 7 — Documentation and deployment

- Document setup, optional environment variables, routing-backend selection, deterministic mode, upload limits, synthetic data, limitations, and test commands.
- Document CSV schema and model metadata only for adapters that are actually implemented.
- Add a sample environment file without secrets.
- Create the system architecture Markdown document from this plan.
- Deploy a Vercel preview and run the acceptance suite against it.

## 13. Assumptions and Explicit Boundaries

- This is a demonstration and referral-navigation tool, not a diagnostic or medical-advice system.
- It will not be represented as HIPAA-compliant or suitable for real protected health information.
- Users are anonymous; there are no accounts or cross-device records.
- Deterministic local-rules mode is the default and is a complete product mode, not a reduced demo path.
- The first implementation uses a small, versioned synthetic routing fixture and requires no symptom-to-specialty CSV.
- The synthetic fixture exists to exercise application behavior and will not be represented as medically comprehensive or clinically validated.
- CSV rules and pretrained-model routing are deferred, interchangeable adapters behind the same `SpecialtyRouter` contract.
- The eventual routing backend may be CSV, a pretrained model, or both; choosing it later will not require rewriting conversation, safety, scheduling, or confirmation modules.
- Uploading symptom context is optional; raw file bytes are processed in memory and never persisted.
- Text, Markdown, JSON, CSV, and text-based PDF context are supported; OCR and image interpretation are outside the MVP.
- If implemented, imported CSV mappings can enrich only the specialist allowlist and cannot change safety rules.
- Imported mapping knowledge is browser-local, user-managed, and treated as unverified demo input.
- If implemented, pretrained-model output is validated against the same specialist allowlist, confidence policy, and primary-care fallback.
- All appointments, clinicians, locations, and availability are fictional demo data.
- Confirmation creates a local demo reservation, not a booking in a real clinical system.
- Routine scheduling stops when an emergency warning sign is detected.
- One best-match specialist or subspecialist is shown, with primary care as the safe low-confidence fallback.
- The scheduling interface remains embedded in the chatbot transcript.
- The application works without a model artifact, endpoint, or key. The server-only AI SDK is installed for optional hybrid enhancement but is not invoked in local mode; a separate future pretrained model may serve as the configured routing backend.
- Vercel deployment is stateless and requires no managed database.
- Real authentication, durable storage, EHR integration, notifications, audit logging, and compliance work are reserved for a future production phase.
