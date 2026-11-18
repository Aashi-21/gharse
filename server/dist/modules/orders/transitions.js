"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.restocksOn = exports.canTransition = exports.ALLOWED_TRANSITIONS = void 0;
/**
 * The only legal order status changes. DELIVERED and CANCELLED are final.
 * Cancelling is allowed only before the order ships (once it is on its way, the seller and customer sort it out directly).
 */
exports.ALLOWED_TRANSITIONS = {
    NEW: ['CONFIRMED', 'CANCELLED'],
    CONFIRMED: ['SHIPPED', 'CANCELLED'],
    SHIPPED: ['DELIVERED'],
    DELIVERED: [],
    CANCELLED: [],
};
const canTransition = (from, to) => exports.ALLOWED_TRANSITIONS[from].includes(to);
exports.canTransition = canTransition;
/** Whether moving to `to` returns the reserved stock to the product. */
const restocksOn = (to) => to === 'CANCELLED';
exports.restocksOn = restocksOn;
//# sourceMappingURL=transitions.js.map