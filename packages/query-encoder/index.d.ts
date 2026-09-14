export class WordPieceTokenizer {
  constructor(tokenizerJson: any);
  encode(text: string, maxLength?: number): { ids: number[]; attentionMask: number[] };
  encodeBatch(texts: string[], maxLength?: number): Array<{ ids: number[]; attentionMask: number[] }>;
}

export class QueryEncoder {
  constructor(session: any, tokenizerJson: any, ort: any, opts?: { maxLen?: number });
  encode(texts: string[]): Promise<Float32Array[]>;
  encodeQuery(text: string): Promise<Float32Array>;
}

export function createNodeEncoder(modelDir: string, opts?: any): Promise<QueryEncoder>;
export function l2Normalize(v: Float32Array): Float32Array;
export const QUERY_PREFIX: string;
export const DIM: number;
export const MAX_LEN: number;
