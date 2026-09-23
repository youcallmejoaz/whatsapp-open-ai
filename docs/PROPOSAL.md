# Proposal: WhatsApp Business + OpenAI integration

This answers the client brief ("integrate our existing WhatsApp Business with ChatGPT/OpenAI…"). This repository is the working reference implementation, and the screenshots in [`docs/screenshots`](screenshots) come from it.

> **Before sending:** put in your own price, timeline and demo link (a deployed instance of this repo plus a short screen recording). The notes below are estimates, not quotes. Meta changes its rules often, so re-check the items marked *(verify at kickoff)* against Meta's current docs.

---

## Suggested reply to the client

Hi, thanks for the detailed brief. I've built a working demo of exactly this:

- the official **WhatsApp Cloud API**,
- **OpenAI** triage, summaries, reports and reply drafting in English and Arabic (including Gulf/Egyptian/Levantine dialects, Arabizi and voice notes),
- an **approval queue** so nothing is sent without a human,
- an **MCP server**, so you can use it from ChatGPT: *"who is waiting for a reply?"*, *"summarise Khalid's chat in Arabic"*, *"draft an apology offering free delivery"*.

Demo: `<your link>` · short video: `<your link>`

Short answers to your questions are below. I'm happy to do a 20-minute call to confirm your country/number setup before quoting a final price.

---

## 1. Can we keep our existing WhatsApp number?

**Yes.** There are two routes, and we choose one at kickoff.

| | **Coexistence** (recommended if available) | **Full migration to the API** |
|---|---|---|
| Phone app | Keeps working on the same number | Stops working for that number |
| Existing chats | Up to **6 months of 1:1 history** synced into the system at onboarding | Not carried over (export first) |
| Replies typed on the phone | Mirrored into the system (`smb_message_echoes`) and clear the "needs reply" flag | n/a |
| Limits | Fixed ~5 msg/s throughput; open the app at least every ~13 days; some companion devices and broadcast lists are disabled; not available in every country *(verify at kickoff)* | Full API throughput, standard Cloud API limits |

Both routes need a **Meta Business Portfolio** and ideally **business verification**, which can take a few days. That is the usual critical-path item, so we start it on day 1.

## 2. What is possible with existing chats and WhatsApp Groups?

- **Existing 1:1 chats**
  - Coexistence imports up to ~6 months automatically.
  - Anything older, or all history if we fully migrate, can be imported from WhatsApp's own **"Export chat" `.txt` files**. The importer handles Android, iOS and Arabic-locale formats. Those chats become searchable and summarizable.
- **Existing groups:** **cannot be read or joined by the official API.**
  - Coexistence does not sync groups.
  - Meta's Groups API only covers **new groups created by the business through the API**. Those groups have up to 8 participants including the business, invite-link joins only, and require an Official Business Account *(verify at kickoff)*.
  - Group chats can still be *exported* manually and imported for search and summaries.
- **What I will not do:** use unofficial libraries (Baileys, whatsapp-web.js, "WhatsApp Web automation"). They can read groups, but they break Meta's terms and risk getting the number **banned**. You asked for the official, production-ready route, and this is part of that.

## 3. Recommended architecture

```
WhatsApp (customers) ─▶ Meta Cloud API ─▶ webhook (signed) ─▶ Node/TypeScript service ─▶ Postgres (+pgvector)
                                                               │  ├─ OpenAI: triage · summaries · drafts · reports · voice-note transcription · embeddings
                                                               │  ├─ Approval queue (web dashboard, EN/AR, RTL)
                                                               │  └─ MCP server ◀── ChatGPT / Claude / OpenAI Responses API
                                                               └─▶ Meta Cloud API (send) — only after a human approves
```

- **Custom service at the core, not n8n.** Approvals, the audit log, the 24-hour messaging rule, idempotent webhook handling and permissions need real code and a real database. n8n is fine *around* it, for example emailing the daily report or pushing urgent items to Slack.
- **OpenAI API** with structured outputs. Every message gets priority, needs-reply, intent, sentiment, language, action items and a one-line summary. The prompts treat customer messages as untrusted data.
- **MCP server rather than a custom GPT action.** One integration works in ChatGPT, Claude and the OpenAI Responses API. The tools can search, summarize, report and **prepare** messages; none of them can send.
- **"Send through ChatGPT instructions":** ChatGPT creates the message and a person approves it with one click. Auto-send can be enabled later for low-risk cases. I don't recommend it on day one.
- **The 24-hour rule:** WhatsApp only allows free-form replies within 24 hours of the customer's last message. After that you need an approved **template**. The system enforces this and offers a template picker.

## 4. Arabic support

- Triage, drafts and summaries work across MSA and dialects.
  - Drafts reply **in the customer's dialect**.
  - Summaries and reports come in whichever language you choose (EN or AR).
- Search is **Arabic-aware**:
  - Normalizes hamza/alef/yaa/taa-marbuta variants and diacritics.
  - Handles Arabic-Indic digits (٤٨٢١ = 4821).
  - Adds semantic search, so "late delivery" finds "الطلب متأخر".
- **Voice notes** are transcribed. They are very common in Gulf/Levant markets.
- The dashboard is fully **RTL**, with Arabic/English switchable per user.

## 5. Delivery plan (estimate; adjust to your pricing)

| Milestone | Scope | Estimate |
|---|---|---|
| M1: Onboarding & ingestion | Meta app, number (coexistence or migration), webhook, storage, history import | 3–5 days *(plus Meta verification time)* |
| M2: AI triage & search | Priority/needs-reply/intent, voice notes, Arabic search, summaries | 4–5 days |
| M3: Drafts, approvals, sending, MCP | Approval dashboard, templates, 24h rule, ChatGPT connector | 4–5 days |
| M4: Reports & hardening | Daily/weekly reports, roles, audit, retention, deployment, handover docs | 3–4 days |

**Total: about 3–4 weeks**, priced as fixed-price milestones. Quote: `<your number>`.

## 6. Ongoing costs to expect

- **Meta (per message):**
  - Replies within the 24h customer-service window are free.
  - Templates are charged per delivered message. The rate depends on category (marketing > utility > authentication) and the recipient's country.
  - Utility templates sent inside an open window are free *(verify current rate card)*.
- **OpenAI (usage-based):**
  - Triaging a few thousand messages a day with a small model costs a few USD per month.
  - Summaries, drafts and reports on a larger model typically total tens of USD per month for an SMB.
  - Voice-note transcription is billed per minute.
- **Hosting:** one small VM or container plus managed Postgres, roughly **USD 15–50/month**.
- **Optional:** a maintenance/support retainer.

## 7. Limitations (stated upfront)

- No access to existing WhatsApp **groups** via the official API (see §2).
- Free-form replies only within **24h**; after that, approved templates only (Meta reviews templates, usually within minutes to hours).
- Coexistence restrictions (throughput, periodic app opening, country availability).
- AI output needs **human review**. The approval step exists because models can be wrong or be manipulated by message content.
- Meta business verification and display-name approval are outside our control and can take days.
- Media (images/documents) is stored as a reference and caption. Image understanding and OCR can be added.
