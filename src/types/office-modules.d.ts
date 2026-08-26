declare module "word-extractor" {
  export class Document {
    getBody(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getHeaders(): string;
    getFooters(): string;
    getTextboxes(): string;
  }

  export default class WordExtractor {
    constructor();
    extract(input: Buffer | string): Promise<Document>;
  }
}

declare module "mammoth" {
  interface ExtractedText {
    value: string;
    messages: { type: string; message: string }[];
  }
  export function extractRawText(
    input: { path: string } | { buffer: Buffer }
  ): Promise<ExtractedText>;

  const mammoth: {
    extractRawText: typeof extractRawText;
  };
  export default mammoth;
}
