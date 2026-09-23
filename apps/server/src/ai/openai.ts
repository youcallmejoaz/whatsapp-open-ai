import OpenAI, { toFile } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { ConversationSummarySchema, TriageSchema } from '@wa/shared';
import type { Config } from '../config.ts';
import { draftPrompt, reportPrompt, summarizePrompt, triagePrompt } from './prompts.ts';
import type { AiProvider, DraftInput, DraftOutput, ReportInput, SummarizeInput, TriageInput } from './provider.ts';

const DraftSchema = z.object({
  body: z.string(),
  language: z.string(),
  rationale: z.string(),
});

const EXT_BY_MIME: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
};

/** OpenAI Responses API with structured outputs, embeddings and speech-to-text. */
export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;
  private readonly cfg: Config;

  constructor(cfg: Config, client?: OpenAI) {
    this.cfg = cfg;
    this.client = client ?? new OpenAI({ apiKey: cfg.OPENAI_API_KEY, maxRetries: 3, timeout: 60_000 });
  }

  private async parse<T extends z.ZodType>(
    model: string,
    prompt: { system: string; user: string },
    schema: T,
    name: string,
  ): Promise<z.infer<T>> {
    const res = await this.client.responses.parse({
      model,
      instructions: prompt.system,
      input: prompt.user,
      text: { format: zodTextFormat(schema, name) },
      store: false,
    });
    if (!res.output_parsed) throw new Error(`OpenAI returned no parsed ${name} output`);
    return res.output_parsed as z.infer<T>;
  }

  triage(input: TriageInput) {
    return this.parse(this.cfg.OPENAI_MODEL_SMALL, triagePrompt(input), TriageSchema, 'triage');
  }

  summarize(input: SummarizeInput) {
    return this.parse(this.cfg.OPENAI_MODEL, summarizePrompt(input), ConversationSummarySchema, 'summary');
  }

  async draftReply(input: DraftInput): Promise<DraftOutput> {
    return this.parse(this.cfg.OPENAI_MODEL, draftPrompt(input), DraftSchema, 'draft');
  }

  async reportNarrative(input: ReportInput): Promise<string> {
    const p = reportPrompt(input);
    const res = await this.client.responses.create({
      model: this.cfg.OPENAI_MODEL,
      instructions: p.system,
      input: p.user,
      store: false,
    });
    return res.output_text.trim();
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.client.embeddings.create({
      model: this.cfg.OPENAI_EMBEDDING_MODEL,
      input: texts.map((t) => t.slice(0, 8000)),
    });
    return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const base = mimeType.split(';')[0]?.trim() ?? '';
    const file = await toFile(audio, `voice.${EXT_BY_MIME[base] ?? 'ogg'}`, { type: base || 'audio/ogg' });
    const res = await this.client.audio.transcriptions.create({ file, model: this.cfg.OPENAI_TRANSCRIBE_MODEL });
    return res.text.trim();
  }
}
