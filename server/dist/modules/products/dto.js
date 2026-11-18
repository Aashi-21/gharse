"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toProductDto = toProductDto;
const publishing_1 = require("./publishing");
const sellerFacts_1 = require("./sellerFacts");
/** Shape sent to the seller's browser. Never exposes storage keys or the raw AI audit blob. */
function toProductDto(p) {
    const image = [...p.images].sort((a, b) => a.position - b.position)[0];
    const facts = (0, sellerFacts_1.readSellerFacts)(p.sellerNotes);
    const issues = (0, publishing_1.getPublishIssues)(p, p.images.length, { live: p.status === 'PUBLISHED' });
    return {
        id: p.id,
        title: p.title,
        description: p.description,
        category: p.category,
        tags: p.tags,
        pricePaise: p.pricePaise,
        stock: p.stock,
        status: p.status,
        sellerNotes: facts.text,
        answers: Object.entries(facts.answers).map(([attribute, a]) => ({ attribute, question: a.question, answer: a.answer })),
        openQuestions: p.openQuestions ?? [],
        visibleCharacteristics: p.visibleCharacteristics,
        brandVersion: p.brandVersion,
        publishedAt: p.publishedAt,
        /** What is still missing before this can be (or stay) live. Computed by the backend; the UI only displays it. */
        readiness: { canPublish: issues.length === 0, issues },
        imageUrl: image ? `/api/seller/products/${p.id}/image` : null,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
    };
}
//# sourceMappingURL=dto.js.map