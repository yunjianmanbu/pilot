import { randomUUID } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  normalizeFeedback,
  type FeedbackContext,
  type FeedbackDraft,
  type FeedbackRecord,
} from '../shared/feedback'

/** Reports are kept one JSON file per submission under the user data folder. */
export class FeedbackBox {
  constructor(private readonly userDataDir: string) {}

  get dir(): string {
    return join(this.userDataDir, 'feedback')
  }

  /** Validate, stamp and persist one report. Returns the stored record. */
  async submit(input: FeedbackDraft, context: FeedbackContext): Promise<FeedbackRecord> {
    const draft = normalizeFeedback(input)
    const createdAt = new Date().toISOString()
    const record: FeedbackRecord = {
      ...draft,
      id: randomUUID(),
      createdAt,
      context,
    }
    await mkdir(this.dir, { recursive: true })
    const stamp = createdAt.replace(/[:.]/g, '-')
    const file = join(this.dir, `${stamp}-${record.id.slice(0, 8)}.json`)
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    return record
  }

  /** Report files, newest first; used by tests and future history views. */
  async list(limit = 20): Promise<string[]> {
    const names = await readdir(this.dir).catch(() => [] as string[])
    return names
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, Math.max(1, limit))
      .map((name) => join(this.dir, name))
  }
}
