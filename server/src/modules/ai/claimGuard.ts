/**
 * Deterministic backstop for the "never invent product facts" rule.
 *
 * The prompt tells Claude not to claim materials, sizes, scent, how it was made, certifications,
 * eco claims, quality grades, price or stock. Models still slip, so generated text is checked here in
 * plain code: any such claim is only allowed if the SELLER's own notes make the same kind of claim.
 * (Facts visible in the photo, like colours and shapes, are not covered by these patterns.)
 */
const PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'how it is made', re: /\bhand[- ]?(made|crafted|poured|knit(ted)?|crocheted|painted|stitched|woven|dipped|carved|finished|rolled|sewn)\b|\b(artisan(al)?|crafted|made by hand|made with love|made to order|custom[- ]made|bespoke)\b/i },
  { label: 'batch / rarity', re: /\b(small|limited)[- ](batch(es)?|edition|run|series)\b|\bone[- ]of[- ]a[- ]kind\b|\blimited stock\b/i },
  { label: 'eco / natural / health claim', re: /\b(eco[- ]?(friendly|conscious)|sustainab\w*|organic|all[- ]natural|plant[- ]based|biodegradable|recycl\w*|upcycl\w*|zero[- ]waste|vegan|cruelty[- ]free|non[- ]?toxic|toxin[- ]free|chemical[- ]free|paraben[- ]free|hypoallergenic|lead[- ]free)\b|100\s?%\s?natural|\bnatural (wax|fib(re|er)s?|ingredients|dyes?|materials?)\b/i },
  { label: 'quality claim', re: /\b(premium|luxury|luxurious|high[- ]quality|top[- ]quality|finest|best[- ]quality|superior|durable|long[- ]lasting|heirloom|authentic|genuine)\b/i },
  { label: 'sourcing / origin', re: /\b(locally[- ]sourced|ethically[- ](sourced|made)|fair[- ]trade|made in [a-z]+|sourced from)\b/i },
  { label: 'certification', re: /\b(certified|certification|iso[- ]?\d+|fssai|oeko[- ]tex|gots)\b/i },
  { label: 'material / ingredient', re: /\b(soy|soya|beeswax|paraffin|(coconut|palm|gel) wax|cotton|wool(l?en)?|acrylic|polyester|silk|jute|merino|epoxy|sterling|stainless|(essential|fragrance) oils?)\b/i },
  { label: 'scent / fragrance', re: /\b(scented|unscented|fragranc\w*|aroma\w*|smells?|scents?|perfumed|lavender|vanilla|jasmine|sandalwood|lemongrass|eucalyptus|cinnamon|musk)\b/i },
  { label: 'dimensions / weight / time', re: /\b\d+(\.\d+)?\s?(cm|mm|inch(es)?|g|gm|gms|grams?|kg|ml|oz|hours?|hrs?|minutes|mins|days|weeks)\b|\b\d+\s?[x×]\s?\d+\b/i },
  { label: 'quantity', re: /\b(set|pack|box|pair|bundle|combo) of \d+\b|\b\d+[- ]?(piece|pieces|pcs|pc|count|pack|pair)\b|\bdozen\b/i },
  { label: 'price / stock / offer', re: /₹|\brs\.?\s?\d|\binr\b|\bpriced?\b|\bsale\b|\bdiscount\w*|\bfree (shipping|delivery)\b|\bin stock\b|\bout of stock\b|\bonly \d+ (left|available)\b|\bbest[- ]?seller\b/i },
  { label: 'spiritual / health / effect claim', re: /\b(healing|heals?|cures?|therapeutic|blessed|spells?|rituals?|good luck|lucky|prosperity|negativity|stress[- ]relie\w*|anxiety|detox\w*|cleans(e|es|ing)|purif\w*|protection from)\b/i },
  { label: 'what is included / props', re: /\b(not included|is included|are included|included (in|with)|includes?|comes with|come with|props?|free gift)\b/i },
  { label: 'safety / use claim', re: /\b(child[- ]safe|food[- ]safe|dishwasher|machine[- ]wash\w*|washable|waterproof|water[- ]resistant|heat[- ]resistant|burn(s)? (for|up to)|burn time|clean[- ]burning|smokeless|drip[- ]free)\b/i },
];

/**
 * Returns the offending phrases found in `generated` that the seller's `sellerNotes` do not back up.
 * A claim category is allowed as soon as the seller's notes make a claim of that same category.
 */
export function findUnsupportedClaims(generated: string[], sellerNotes: string): string[] {
  const text = generated.join('\n');
  const found: string[] = [];
  for (const { re } of PATTERNS) {
    const m = text.match(re);
    if (m && !re.test(sellerNotes)) found.push(m[0].trim());
  }
  return found;
}

/** Every unsupported phrase with its category, for the corrective retry message and for tests. */
export function describeClaims(generated: string[], sellerNotes: string): { phrase: string; kind: string }[] {
  const text = generated.join('\n');
  const out: { phrase: string; kind: string }[] = [];
  const seen = new Set<string>();
  for (const { re, label } of PATTERNS) {
    if (re.test(sellerNotes)) continue; // the seller made this kind of claim themselves
    for (const m of text.matchAll(new RegExp(re.source, 'gi'))) {
      const phrase = m[0].trim();
      if (!seen.has(phrase.toLowerCase())) {
        seen.add(phrase.toLowerCase());
        out.push({ phrase, kind: label });
      }
    }
  }
  return out;
}
