# Health Check Scheduler — Architecture and Delivery Plan

## 1. Summary

Build a lightweight, self-contained chatbot web application that:

1. Collects the user’s symptoms in conversational language.
2. Checks for urgent warning signs before routine scheduling.
3. Optionally incorporates user-uploaded symptom-history material after showing the extracted context for review.
4. Asks two to four relevant follow-up questions.
5. Routes symptoms using a bundled symptom-to-specialty catalog that can be expanded with validated CSV mapping packs.
6. Recommends one suitable specialist or subspecialist with a brief, evidence-linked explanation.
7. Guides the user through location, duration, date, and time selection using controls embedded in the conversation.
8. Creates a browser-local appointment with a confirmation code and summary.

The first release is a safe demonstration, not a diagnostic product or production medical system. It will run locally and deploy as a single Vercel project without requiring a database.

The deterministic conversation, document-processing, routing, safety, scheduling, and confirmation modules form the complete application. No LLM call, model credential, or external service is required. An optional LLM adapter may improve natural-language extraction and conversational wording, but it cannot own safety decisions, routing constraints, workflow state, or scheduling. Removing or disabling that adapter must leave the full application functional.

## 2. Proposed Architecture

### Application stack

- Next.js with the App Router and TypeScript.
- React for the compact chat interface and inline scheduling widgets.
- Tailwind CSS for responsive styling.
- Zod schemas for API, triage, catalog, context evidence, CSV mappings, and appointment validation.
- Vitest and React Testing Library for unit and component tests.
- Playwright for the complete chat-to-confirmation flow.
- An optional Vercel-compatible serverless route used only for conversation enhancement.
- Browser `localStorage` for conversations and appointments.
- Browser IndexedDB for validated mapping packs and approved extracted context.
- Client-side parsing for CSV, text, Markdown, JSON, and PDF context files.
- Static TypeScript or JSON fixtures for specialists, locations, routing rules, follow-up questions, and availability.

The repository will contain three main architectural areas:

- `app/`: Chat page, optional enhancement route, layout, and styling.
- `components/`: Transcript, composer, upload and mapping-management surfaces, inline selection controls, recommendation, urgent-warning, and confirmation cards.
- `lib/`: Framework-independent core modules, knowledge ingestion and validation, deterministic and optional LLM adapters, scheduling, seeded catalogs, and browser persistence.

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
          └─ RoutingKnowledgeRepository port
               ├─ Bundled mapping catalog
               └─ Validated browser-local CSV packs
```

The deterministic adapters are the default implementations and must support every state in the end-to-end workflow. Optional adapters may add richer interpretation, but they return suggestions through the same validated interfaces and cannot add new workflow capabilities.

Two runtime modes will be supported:

- `deterministic` is the default. All chat decisions, context extraction, routing, and scheduling execute locally. The browser never calls a model endpoint.
- `enhanced` runs the deterministic pipeline first, then may ask the server-side LLM adapter to improve extraction or phrasing. A timeout, invalid response, missing key, quota error, or disabled endpoint immediately returns the already-computed deterministic result.

The selected mode will be controlled by configuration and exposed as a read-only indicator in the UI. Core code and tests must not require the enhanced adapter to be installed or configured.

### Runtime topology

```text
Browser
  ├─ Chat transcript and embedded scheduling controls
  ├─ Conversation state
  ├─ Local context extraction and review
  ├─ Bundled and imported routing knowledge
  ├─ Seeded schedule catalog
  ├─ Availability calculation
  └─ Local conversations and appointments
             │
             ├──────── Deterministic mode ends here
             │
             └──────── Optional enhanced mode
                              │
                              ▼
                    Next.js /api/enhance route
                      ├─ Request validation
                      ├─ Data-minimization gate
                      ├─ Timeout and schema enforcement
                      └─ Optional LLM adapter
```

No database, authentication service, calendar service, email provider, or language-model provider is required for the MVP.

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

The routing engine will support a curated catalog containing:

- Primary care.
- Cardiology.
- Dermatology.
- Endocrinology.
- Gastroenterology.
- Neurology.
- Orthopedics.
- Otolaryngology/ENT.
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
- Bundled symptom-to-specialty mappings.
- Active, validated CSV mapping packs.
- Answers to deterministic follow-up questions.

The safety policy always runs before scoring and cannot be replaced or weakened by an imported mapping. Bundled and imported mappings participate in the same scoring model. Higher evidence scores win; if scores tie, the bundled mapping wins. Conflicting or weak evidence produces a primary-care fallback rather than arbitrary tie-breaking.

The output will be one best-match specialty or subspecialty and a concise reason that identifies the relevant user-provided facts without asserting a diagnosis. Low-confidence or unsupported cases will fall back to primary care rather than inventing a precise referral.

## 4. Context and Routing-Knowledge Uploads

Uploads are divided into two explicit types because they have different trust, privacy, validation, and persistence rules.

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

A mapping-management drawer will allow a user or demo administrator to import additional routing knowledge as CSV. The import flow will provide a downloadable template, validation preview, activation control, pack status, and delete action.

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

### Knowledge precedence and provenance

The routing engine will retain evidence provenance so a result can be reproduced and explained:

1. Immutable emergency and workflow rules.
2. Current facts directly stated and confirmed by the user.
3. User-approved facts extracted from historical files.
4. Bundled and active imported mapping evidence.
5. Primary-care fallback when confidence remains insufficient.

Recommendations will record which bundled catalog version and imported pack checksums contributed to the result. The UI will explain that imported packs are unverified demo knowledge and provide a one-click path to disable them.

## 5. Deterministic Core and Optional Conversation Enhancement

### Deterministic application core

Application code will exclusively own and fully implement:

- Red-flag detection.
- Workflow state and valid transitions.
- Natural-language normalization for the supported symptom vocabulary.
- Local context extraction and fact review.
- Mapping-pack parsing, validation, activation, and provenance.
- Specialist and subspecialist allowlists.
- Specialist scoring and primary-care fallback.
- Maximum follow-up count.
- Complete user-facing messages and question templates.
- Scheduling constraints and availability.
- Appointment validation and confirmation.
- All fallback and recovery behavior.

This core must be usable directly from the browser application. It will expose framework-independent functions that accept validated state and return the next state, message content, structured action, and evidence. No call site in the core will assume that an LLM result will arrive later.

### Optional model responsibilities

When enhanced mode is explicitly enabled and configured, the language model may:

- Summarize the user’s symptom description.
- Select the most useful next question from an allowed set.
- Map natural-language answers into structured fields.
- Propose a route from the permitted specialist catalog.
- Generate short, empathetic conversational wording.

The deterministic result is computed before an enhancement request. The model response must conform to a validated structured schema containing:

- Assistant message.
- Normalized symptom facts.
- Proposed next action.
- Optional follow-up question identifier.
- Optional allowed specialist identifier.
- Confidence indicator.
- Safety flags for secondary deterministic review.

Invalid, unsupported, or timed-out model results will be discarded, and the already-computed deterministic result will be returned unchanged. Model output is advisory: the deterministic safety and routing engine must validate every proposed fact, question, and specialist identifier before using it.

### Fully self-contained mode

Deterministic mode is a first-class deployment profile, not a degraded fallback. In this mode:

- No chat or document content is sent to a server-side model route.
- Keyword normalization, decision tables, file extraction, and mappings run in the browser.
- Follow-up questions will come from specialty-specific templates.
- Routing will use weighted symptom-to-specialty rules.
- File uploads, mapping-pack imports, scheduling, persistence, and confirmation remain available.
- The entire acceptance suite will run without any model environment variables.
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
  mappingPackChecksums: string[];
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

type ChatAction =
  | { type: "ask_follow_up"; questionId: string }
  | { type: "review_context"; evidence: SymptomEvidence[] }
  | { type: "show_recommendation"; recommendation: Recommendation }
  | { type: "show_urgent_guidance"; category: string }
  | { type: "start_scheduling"; specialtyId: string }
  | { type: "recoverable_error"; message: string };
```

The local conversation application service will accept the current state, latest user event, approved evidence, and active routing knowledge. It will synchronously return:

- A display-safe assistant message.
- The next valid conversation stage.
- A typed UI action.
- Updated structured symptom facts.
- Optional recommendation information.
- Evidence and mapping provenance.
- The active execution mode.

The replaceable module contracts will include:

```ts
interface ConversationEnhancer {
  enhance(input: EnhancementInput): Promise<EnhancementSuggestion>;
}

interface ContextExtractor {
  extract(input: ContextFile): Promise<ExtractedContext>;
}

interface RoutingKnowledgeRepository {
  getBundledMappings(): SymptomSpecialtyMapping[];
  getActiveImportedMappings(): Promise<SymptomSpecialtyMapping[]>;
}
```

The optional `/api/enhance` endpoint will accept only the validated, minimized enhancement input and return a schema-validated suggestion. The primary chat workflow will not depend on this endpoint and will never wait indefinitely for it.

Appointment creation will remain client-side in the MVP because all catalog and persistence data are browser-local.

## 8. User Interface Structure

The application will use a single responsive screen:

- Small application header with title and “New conversation.”
- Scrollable transcript area.
- Compact assistant and user message bubbles.
- Attachment control for symptom-history material.
- Extracted-context review cards with source, temporality, edit, approve, and remove actions.
- Mapping-pack manager with CSV template download, validation preview, activate/deactivate, and delete actions.
- A visible “Local rules mode” or “Enhanced mode” indicator.
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

- Validated mapping-pack metadata and normalized rows.
- User-approved extracted context associated with a conversation.
- Catalog and mapping checksums needed to reproduce a recommendation.

Persistence behavior will include:

- Runtime schema validation when loading stored data.
- Safe reset if stored data is corrupt or incompatible.
- A visible “Clear demo data” action.
- Separate controls to clear symptom context, mapping packs, appointments, or all local data.
- No persistence of raw uploaded file bytes.
- No secrets or model credentials in local storage.
- No full date of birth, insurance data, payment data, or medical record identifiers.
- A notice explaining that symptom text, approved extracts, imported mappings, and appointments remain on the current browser.

In deterministic mode, user text and extracted context do not leave the browser. In enhanced mode, only the minimum approved summary required for the next step may be sent to the configured provider. Each context-review card will disclose whether its approved summary is eligible for enhancement, and users can keep it local.

## 10. Error and Recovery Behavior

- Model timeout or API failure: Continue through deterministic mode without losing the transcript.
- Invalid model output: Reject it and use rule-based output.
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
- Specialty scoring, tie-breaking, confidence fallback, and allowlist enforcement.
- Combined scoring from conversation facts, approved file evidence, bundled mappings, and imported mappings.
- CSV quoted fields, header normalization, row validation, duplicate detection, schema versions, checksums, and pack activation.
- Protection against unknown specialty identifiers, invalid placeholders, and executable content.
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
- Mapping-pack preview, error display, activation, deactivation, and deletion.
- Execution-mode indicator and local-only context control.
- Inline location, duration, date, and time controls.
- Clearing dependent selections when an earlier choice changes.
- Recommendation explanation.
- Urgent-exit presentation and disabled scheduling.
- Appointment review and confirmation.
- Keyboard navigation and accessible status announcements.

### End-to-end scenarios

1. Common symptom → follow-ups → specialist → completed booking.
2. Specific symptom pattern → subspecialist → completed booking.
3. User uploads historical notes → reviews extracted facts → receives an evidence-linked recommendation.
4. Historical file mentions an urgent symptom → chatbot confirms whether it is current before emergency handling.
5. Valid CSV pack adds a new symptom phrase → routing uses it and records pack provenance.
6. Invalid or conflicting CSV pack → activation is blocked with actionable row-level errors.
7. Mapping pack is disabled → subsequent routing returns to bundled behavior.
8. Ambiguous symptoms → primary-care fallback.
9. Emergency warning sign in current input → immediate routine-flow termination.
10. No model dependency or credential in the build → complete upload, routing, scheduling, and confirmation experience.
11. Enhancement request fails mid-conversation → deterministic result appears without losing state.
12. No slots for chosen combination → successful alternate selection.
13. Page refresh during scheduling → restored workflow and approved context.
14. Confirmation → persisted appointment, knowledge provenance, and unique confirmation code.
15. Locally conflicting appointment → unavailable slot excluded.
16. Mobile viewport → usable chat, upload review, and scheduling controls.
17. Corrupt browser storage → safe recovery without a blank or broken application.

Acceptance requires all scenarios except the explicitly enhanced-mode failure scenario to pass with the LLM adapter disabled and no model environment variables. The complete suite must work locally and in a Vercel preview deployment.

## 12. Delivery Phases

### Phase 1 — Foundation

- Initialize Next.js, TypeScript, styling, validation, and test tooling.
- Establish domain types and the explicit conversation state machine.
- Define the ports for conversation enhancement, context extraction, and routing knowledge.
- Add the responsive single-screen chat shell.
- Add seeded specialty, location, duration, and availability data.

### Phase 2 — Complete deterministic application

- Implement symptom normalization, urgent screening, follow-up templates, and routing rules.
- Build the full rules-only conversational path.
- Add inline scheduling controls and availability calculation.
- Add browser persistence and confirmation generation.
- Prove the full application flow with no model SDK, endpoint, key, or network request.

### Phase 3 — Context and mapping extensibility

- Add local parsers and review UI for text, Markdown, JSON, CSV, and text-based PDF context.
- Add evidence provenance, temporality confirmation, and context removal/recalculation.
- Add the CSV mapping template, validator, preview, activation, and IndexedDB repository.
- Integrate bundled and imported mapping evidence with deterministic routing.

### Phase 4 — Optional model enhancement

- Add the server-side model adapter and structured response schema.
- Constrain model decisions to the curated question and specialist catalogs.
- Implement explicit context consent, minimization, timeout, validation, and deterministic fallback behavior.
- Add minimal-context handling and secret-safe configuration.

### Phase 5 — Safety and quality

- Add disclaimers, urgent-exit behavior, accessibility refinements, and privacy messaging.
- Complete unit, component, and end-to-end coverage.
- Validate responsive behavior and keyboard-only operation.
- Verify local production builds and Vercel serverless compatibility.

### Phase 6 — Documentation and deployment

- Document setup, optional environment variables, deterministic mode, upload limits, CSV schema, seeded data, limitations, and test commands.
- Include an example valid mapping pack and examples that demonstrate common validation failures.
- Add a sample environment file without secrets.
- Create the system architecture Markdown document from this plan.
- Deploy a Vercel preview and run the acceptance suite against it.

## 13. Assumptions and Explicit Boundaries

- This is a demonstration and referral-navigation tool, not a diagnostic or medical-advice system.
- It will not be represented as HIPAA-compliant or suitable for real protected health information.
- Users are anonymous; there are no accounts or cross-device records.
- Deterministic local-rules mode is the default and is a complete product mode, not a reduced demo path.
- Uploading symptom context is optional; raw file bytes are processed in memory and never persisted.
- Text, Markdown, JSON, CSV, and text-based PDF context are supported; OCR and image interpretation are outside the MVP.
- Imported CSV mappings can enrich only the bundled specialist allowlist and cannot change safety rules.
- Imported mapping knowledge is browser-local, user-managed, and treated as unverified demo input.
- All appointments, clinicians, locations, and availability are fictional demo data.
- Confirmation creates a local demo reservation, not a booking in a real clinical system.
- Routine scheduling stops when an emergency warning sign is detected.
- One best-match specialist or subspecialist is shown, with primary care as the safe low-confidence fallback.
- The scheduling interface remains embedded in the chatbot transcript.
- The application works without a model package, endpoint, or key; a configured model only improves supported interpretation and wording.
- Vercel deployment is stateless and requires no managed database.
- Real authentication, durable storage, EHR integration, notifications, audit logging, and compliance work are reserved for a future production phase.
