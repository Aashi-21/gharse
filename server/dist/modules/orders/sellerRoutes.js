"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toSellerOrder = toSellerOrder;
exports.sellerOrderRoutes = sellerOrderRoutes;
const zod_1 = require("zod");
const httpError_1 = require("../../lib/httpError");
const ownership_1 = require("../../lib/ownership");
const transitions_1 = require("./transitions");
const STATUSES = ['NEW', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
/**
 * Seller's view of an order. This is the ONLY place customer details leave the database, and only to the seller who owns
 * the store. Internal columns (storeId, idempotencyKey, requestHash) are never included.
 */
function toSellerOrder(o) {
    return {
        id: o.id,
        number: o.orderNumber,
        status: o.status,
        customer: { name: o.customerName, phone: o.customerPhone },
        address: { line1: o.shippingLine1, line2: o.shippingLine2, city: o.shippingCity, state: o.shippingState, pincode: o.shippingPincode },
        note: o.note,
        items: o.items.map((i) => ({ title: i.titleSnapshot, unitPricePaise: i.unitPricePaise, quantity: i.quantity })),
        subtotalPaise: o.subtotalPaise,
        deliveryPaise: o.deliveryPaise,
        totalPaise: o.totalPaise,
        trackingNote: o.trackingNote,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
    };
}
const listQuery = zod_1.z.object({
    status: zod_1.z.enum(STATUSES).optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).default(50),
    cursor: zod_1.z.string().min(1).max(40).optional(),
});
const statusBody = zod_1.z.object({
    status: zod_1.z.enum(STATUSES, { error: 'Choose a valid status' }),
    trackingNote: zod_1.z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), zod_1.z.string().trim().max(200, 'Keep the tracking note under 200 characters').optional()),
});
/** The seller's order management. Every query starts from the seller's own store, so another seller's order is simply "not found". */
async function sellerOrderRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    app.get('/api/seller/orders', async (req) => {
        const q = listQuery.parse(req.query);
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        if (q.cursor && !(await app.prisma.order.findFirst({ where: { id: q.cursor, storeId: store.id }, select: { id: true } }))) {
            throw new httpError_1.HttpError(400, 'validation_error', 'Invalid page cursor.', { cursor: 'Invalid cursor' });
        }
        const [rows, grouped] = await Promise.all([
            app.prisma.order.findMany({
                where: { storeId: store.id, ...(q.status && { status: q.status }) },
                include: { items: true },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: q.limit + 1,
                ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
            }),
            app.prisma.order.groupBy({ by: ['status'], where: { storeId: store.id }, _count: { _all: true } }),
        ]);
        const page = rows.slice(0, q.limit);
        const counts = Object.fromEntries(STATUSES.map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0]));
        return { orders: page.map(toSellerOrder), nextCursor: rows.length > q.limit ? page[page.length - 1].id : null, counts };
    });
    app.get('/api/seller/orders/:id', async (req) => {
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        const order = await app.prisma.order.findFirst({ where: { id: req.params.id, storeId: store.id }, include: { items: true } });
        if (!order)
            throw new httpError_1.HttpError(404, 'not_found', 'Order not found.');
        return { order: toSellerOrder(order) };
    });
    // One transaction, on a row-locked order: validate the transition, (on cancel) return the reserved stock, write the status.
    // The lock makes concurrent or repeated requests safe: stock can never be restored twice.
    app.patch('/api/seller/orders/:id/status', async (req) => {
        const body = statusBody.parse(req.body);
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        if (body.trackingNote !== undefined && body.status !== 'SHIPPED') {
            throw new httpError_1.HttpError(400, 'validation_error', 'A tracking note can only be added when marking an order as shipped.', { trackingNote: 'Only for shipped orders' });
        }
        const order = await app.prisma.$transaction(async (tx) => {
            const locked = await tx.$queryRaw `SELECT id FROM orders WHERE id = ${req.params.id} AND "storeId" = ${store.id} FOR UPDATE`;
            if (locked.length === 0)
                throw new httpError_1.HttpError(404, 'not_found', 'Order not found.');
            const cur = await tx.order.findUniqueOrThrow({ where: { id: req.params.id }, include: { items: true } });
            if (cur.status === body.status) {
                // Repeating the same status is harmless (double-click). On SHIPPED it may refresh the tracking note.
                if (body.status === 'SHIPPED' && body.trackingNote !== undefined) {
                    return tx.order.update({ where: { id: cur.id }, data: { trackingNote: body.trackingNote }, include: { items: true } });
                }
                return cur;
            }
            if (!(0, transitions_1.canTransition)(cur.status, body.status)) {
                throw new httpError_1.HttpError(409, 'invalid_transition', `An order that is ${cur.status.toLowerCase()} cannot be changed to ${body.status.toLowerCase()}.`);
            }
            if ((0, transitions_1.restocksOn)(body.status)) {
                for (const item of cur.items) {
                    if (item.productId) {
                        await tx.$executeRaw `UPDATE products SET stock = stock + ${item.quantity} WHERE id = ${item.productId}`;
                    }
                }
            }
            const data = { status: body.status };
            if (body.status === 'SHIPPED' && body.trackingNote !== undefined)
                data.trackingNote = body.trackingNote;
            return tx.order.update({ where: { id: cur.id }, data, include: { items: true } });
        });
        return { order: toSellerOrder(order) };
    });
}
//# sourceMappingURL=sellerRoutes.js.map