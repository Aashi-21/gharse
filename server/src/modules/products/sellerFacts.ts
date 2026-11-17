/**
 * Facts the SELLER supplied about a product: free-text notes (typed at upload) plus answers to the
 * questions Claude could not settle from the photo. Stored in products.sellerNotes (JSON); rows written before
 * answers existed only have { text }.
 */
export interface SellerFacts {
  text: string;
  answers: Record<string, { question: string; answer: string }>;
}

export function readSellerFacts(json: unknown): SellerFacts {
  const raw = (json ?? {}) as { text?: unknown; answers?: unknown };
  const answers: SellerFacts['answers'] = {};
  if (raw.answers && typeof raw.answers === 'object') {
    for (const [attr, v] of Object.entries(raw.answers as Record<string, { question?: unknown; answer?: unknown }>)) {
      if (v && typeof v.answer === 'string' && v.answer.trim()) {
        answers[attr] = { question: typeof v.question === 'string' ? v.question : attr, answer: v.answer };
      }
    }
  }
  return { text: typeof raw.text === 'string' ? raw.text : '', answers };
}

/** What Claude is shown: notes plus each question with the seller's answer. */
export function factsForPrompt(f: SellerFacts): string {
  const lines = Object.values(f.answers).map((a) => `- ${a.question} => ${a.answer}`);
  return [f.text, lines.length ? `Answers from the seller:\n${lines.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

/**
 * What the claim guard treats as "stated by the seller": the notes and the ANSWERS only.
 * Question text is deliberately excluded: Claude wrote the questions, so they prove nothing.
 */
export function factsForGuard(f: SellerFacts): string {
  return [f.text, ...Object.values(f.answers).map((a) => a.answer)].filter(Boolean).join('\n');
}
