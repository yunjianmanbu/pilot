/**
 * Type declarations for renderer-only vendors that ship no `.d.ts`.
 *
 * `mammoth` publishes only the JavaScript builds (the browser bundle and the
 * Node one), so the three entry points used by `preview/docx.ts` are declared
 * here instead of pulling in `@types/mammoth`, which does not exist. Keep this
 * in sync with the calls in that file rather than describing the whole API.
 */
declare module 'mammoth' {
  export interface DocumentInput {
    arrayBuffer?: ArrayBuffer
    buffer?: Uint8Array
    path?: string
  }

  export interface ConversionMessage {
    type?: string
    message: string
  }

  export interface ConversionResult {
    value: string
    messages: ConversionMessage[]
  }

  export interface ConversionOptions {
    styleMap?: string[]
    includeDefaultStyleMap?: boolean
    convertImage?: unknown
    ignoreEmptyParagraphs?: boolean
  }

  const mammoth: {
    convertToHtml(input: DocumentInput, options?: ConversionOptions): Promise<ConversionResult>
    convertToMarkdown(input: DocumentInput, options?: ConversionOptions): Promise<ConversionResult>
    extractRawText(input: DocumentInput): Promise<ConversionResult>
  }

  export default mammoth
}
