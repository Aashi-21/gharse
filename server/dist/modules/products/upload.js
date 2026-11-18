"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readProductUpload = readProductUpload;
const zod_1 = require("zod");
const httpError_1 = require("../../lib/httpError");
const imageInfo_1 = require("../../lib/imageInfo");
const imageTooLarge = () => new httpError_1.HttpError(413, 'image_too_large', `The photo is too large. Please use one under ${imageInfo_1.IMAGE_LIMITS.maxBytes / 1024 / 1024} MB.`);
const notesSchema = zod_1.z.string().trim().max(600, 'Keep the notes under 600 characters');
/**
 * Reads a multipart upload with exactly one file field "image" (and an optional text field "notes"),
 * then validates the BYTES: real format (JPEG/PNG/WebP), pixel dimensions and size.
 * The client-supplied filename and content-type are never trusted or used for storage paths.
 */
async function readProductUpload(req) {
    if (!req.isMultipart())
        throw new httpError_1.HttpError(415, 'bad_upload', 'Please upload the photo as a form upload.');
    let image = null;
    let notesRaw = '';
    try {
        for await (const part of req.parts()) {
            if (part.type === 'file') {
                if (part.fieldname !== 'image' || image) {
                    await part.toBuffer().catch(() => undefined); // drain
                    throw new httpError_1.HttpError(400, 'bad_upload', 'Upload exactly one photo.');
                }
                image = await part.toBuffer(); // throws FST_REQ_FILE_TOO_LARGE past the size limit
                // Defence in depth: never trust a single layer to have enforced the limit.
                if (image.length > imageInfo_1.IMAGE_LIMITS.maxBytes)
                    throw imageTooLarge();
            }
            else if (part.fieldname === 'notes' && typeof part.value === 'string') {
                notesRaw = part.value;
            }
        }
    }
    catch (err) {
        if (err instanceof httpError_1.HttpError)
            throw err;
        const code = err.code;
        if (code === 'FST_REQ_FILE_TOO_LARGE') {
            throw imageTooLarge();
        }
        if (code?.startsWith('FST_'))
            throw new httpError_1.HttpError(400, 'bad_upload', 'The upload could not be read. Please try again.');
        throw err;
    }
    if (!image)
        throw new httpError_1.HttpError(400, 'image_required', 'Please choose a product photo.');
    const info = (0, imageInfo_1.inspectImage)(image);
    if (!info)
        throw new httpError_1.HttpError(415, 'unsupported_image', 'Please upload a JPEG, PNG or WebP photo.');
    const { width, height } = info;
    if (Math.min(width, height) < imageInfo_1.IMAGE_LIMITS.minDimension) {
        throw new httpError_1.HttpError(400, 'image_dimensions', 'This photo is too small. Please use a larger one.');
    }
    if (Math.max(width, height) > imageInfo_1.IMAGE_LIMITS.maxDimension) {
        throw new httpError_1.HttpError(400, 'image_dimensions', `This photo is too large (over ${imageInfo_1.IMAGE_LIMITS.maxDimension}px). Please use a smaller one.`);
    }
    const notes = notesSchema.safeParse(notesRaw);
    if (!notes.success)
        throw new httpError_1.HttpError(400, 'validation_error', 'Please check the notes.', { notes: notes.error.issues[0].message });
    return { image, info, notes: notes.data };
}
//# sourceMappingURL=upload.js.map