"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readSellerFacts = readSellerFacts;
exports.factsForPrompt = factsForPrompt;
exports.factsForGuard = factsForGuard;
function readSellerFacts(json) {
    const raw = (json ?? {});
    const answers = {};
    if (raw.answers && typeof raw.answers === 'object') {
        for (const [attr, v] of Object.entries(raw.answers)) {
            if (v && typeof v.answer === 'string' && v.answer.trim()) {
                answers[attr] = { question: typeof v.question === 'string' ? v.question : attr, answer: v.answer };
            }
        }
    }
    return { text: typeof raw.text === 'string' ? raw.text : '', answers };
}
/** What Claude is shown: notes plus each question with the seller's answer. */
function factsForPrompt(f) {
    const lines = Object.values(f.answers).map((a) => `- ${a.question} => ${a.answer}`);
    return [f.text, lines.length ? `Answers from the seller:\n${lines.join('\n')}` : ''].filter(Boolean).join('\n\n');
}
/**
 * What the claim guard treats as "stated by the seller": the notes and the ANSWERS only.
 * Question text is deliberately excluded: Claude wrote the questions, so they prove nothing.
 */
function factsForGuard(f) {
    return [f.text, ...Object.values(f.answers).map((a) => a.answer)].filter(Boolean).join('\n');
}
//# sourceMappingURL=sellerFacts.js.map