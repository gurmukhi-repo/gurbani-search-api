export interface LineResult {
  line_id: number;
  verse_id: number;
  shabad_id: number;
  ang: number;
  line_no?: number | null;
  position_in_shabad: number;
  gurmukhi_uni: string;
  gurmukhi_ascii: string;
  first_letters_ascii: string;
  first_letters_codes: string;
  kind: string;
  rahao_kind: string;
  writer?: string | null;
  raag?: string | null;
  score?: number;
  highlight?: { firstWord: number; lastWord: number } | null;
}

export interface ShabadResult {
  shabad_id: number;
  writer?: string | null;
  raag?: string | null;
  ang_start: number;
  line_count: number;
  has_rahao: number;
  rahao_line?: string | null;
  first_line?: string | null;
  score?: number;
}

export interface DbAdapter {
  all(sql: string, params?: any[]): any[];
  close(): void;
}

export interface SemanticHit {
  id: number;
  row: number;
  score: number;
}

export interface VectorIndex {
  search(query: Float32Array, k?: number, opts?: { excludeRow?: number; filter?: (id: number) => boolean }): SemanticHit[];
  similarTo(id: number, k?: number, opts?: { filter?: (id: number) => boolean }): SemanticHit[];
}

export interface LoadedArtifacts {
  manifest: any;
  lines: VectorIndex;
  shabads: VectorIndex;
  rahao: VectorIndex;
  pca: {
    components: Float32Array;
    mean: Float32Array;
    inDim: number;
    outDim: number;
  };
}

export function openNodeAdapter(dbPath: string, opts?: { readOnly?: boolean }): DbAdapter;
export function firstLetterAnywhere(db: DbAdapter, input: string, opts?: { limit?: number }): LineResult[];
export function firstLetterStart(db: DbAdapter, input: string, opts?: { limit?: number }): LineResult[];
export function firstLetterAnywhereCount(db: DbAdapter, input: string): number;

export function similarLines(art: LoadedArtifacts, lineId: number, k?: number): SemanticHit[];
export function similarShabads(art: LoadedArtifacts, shabadId: number, k?: number): SemanticHit[];
export function similarByRahao(art: LoadedArtifacts, shabadId: number, k?: number): SemanticHit[];
export function searchText(art: LoadedArtifacts, queryVec: Float32Array, level?: 'lines' | 'shabads' | 'rahao', k?: number): SemanticHit[];
export function projectQuery(pca: any, embedding: Float32Array): Float32Array;
export function loadArtifacts(readFile: (name: string) => Promise<ArrayBuffer | Uint8Array>, opts?: { semantic?: boolean }): Promise<LoadedArtifacts>;
export function nodeReadFile(dir: string): (name: string) => Promise<Buffer>;

export const keyboard: {
  PAINTI: string[][];
  NUKTA_ROW: string[];
  ALL_KEYS: string[];
  keyToAscii(letter: string): string;
  matchSpan(firstLettersAscii: string, input: string): { start: number; length: number } | null;
  firstLetterWordMap(asciiLine: string): { words: string[]; wordOf: number[] };
  highlightWords(asciiLine: string, firstLettersAscii: string, input: string): { firstWord: number; lastWord: number } | null;
};

export const gurmukhi: {
  toAscii(unicodeStr: string): string;
  toUnicode(asciiStr: string): string;
  firstLettersAscii(asciiStr: string): string;
  buildQuery(rawInput: string): string;
  bindiVariant(charCodeQuery: string): string | null;
  stripNukta(input: string): string;
  suffixTokens(charCodeStr: string): string[];
};
