import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeClaims, findUnsupportedClaims } from '../src/modules/ai/claimGuard';

const flagged = (text: string, notes = '') => findUnsupportedClaims([text], notes);

describe('factual claim guard', () => {
  it('flags every category of invented claim when the seller never said it', () => {
    const cases = [
      'A handmade candle', 'Hand-poured with care', 'Crafted by artisans', 'Made in small batches', 'A limited edition piece',
      'Made from soy wax', '100% cotton yarn', 'Lightly scented with lavender', 'Smells like vanilla',
      'Measures 10 cm tall', 'Weighs 200 g', 'Burns for 40 hours', 'A 10 x 5 jar', 'Set of 3 candles', '4 pieces included',
      'An eco-friendly choice', 'Sustainable and organic', 'Vegan and cruelty-free', 'Non-toxic',
      'A premium finish', 'Luxurious feel', 'High-quality build', 'Durable and long-lasting',
      'Locally sourced', 'Made in India', 'Certified safe', 'Priced at ₹499', 'Rs. 299 only', 'Only 3 left in stock', 'Machine washable', 'Waterproof', 'Brings good luck', 'Removes negativity', 'Healing energy', 'Used in rituals', 'Great stress relief', 'The bear is just a friendly prop', 'Comes with a lid', 'Includes two candles', 'Bear not included',
    ];
    for (const c of cases) assert.ok(flagged(c).length > 0, c);
  });

  it('allows ordinary descriptions of what is visible', () => {
    const ok = [
      'A white pillar candle inside a clear glass jar with a plain cream label.',
      'A cream-coloured basket with chunky looped stitches and two short handles.',
      'Sits on a wooden tray next to a small green plant. Soft evening light.',
      'A calm, soft-looking piece with a quiet glow for a bedside table.',
      'Held in one hand for scale. Gold lettering on a black label.',
      'candle, glass jar, white, home decor, bedside',
      'A small teal crochet bear also appears in the photo, peeking over the top.',
    ];
    for (const t of ok) assert.deepEqual(flagged(t), [], t);
  });

  it('allows a claim once the seller states that kind of fact themselves', () => {
    assert.deepEqual(flagged('Hand-poured soy wax candle', 'Soy wax, hand poured'), []);
    assert.deepEqual(flagged('A 200 g candle that burns for 40 hours', 'Weight 200g, burn time 40 hours'), []);
    assert.deepEqual(flagged('Lightly scented with lavender', 'lavender scented'), []);
    assert.deepEqual(flagged('Made from 100% cotton', 'cotton yarn'), []);
  });

  it('still flags claims the seller did not make, even when they made others', () => {
    const r = flagged('Hand-poured soy candle, eco-friendly, 200 g', 'It is a soy candle');
    assert.ok(r.some((x) => /hand/i.test(x)));
    assert.ok(r.some((x) => /eco/i.test(x)));
    assert.ok(r.some((x) => /200/.test(x)));
    assert.ok(!r.some((x) => /soy/i.test(x)));
  });

  it('is case-insensitive and reports the category', () => {
    const d = describeClaims(['HANDMADE Candle'], '');
    assert.equal(d[0].kind, 'how it is made');
  });
});
