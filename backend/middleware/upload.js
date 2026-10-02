const multer = require('multer');

// Files are held in memory (as a Buffer) just long enough to stream them to
// Cloudinary - nothing is ever written to disk on the server.
const storage = multer.memoryStorage();

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Vercel refuses request bodies above ~4.5 MB. These legacy multipart endpoints (they still work,
// the site itself now prefers direct-to-Cloudinary uploads - see routes/uploadRoutes.js /sign) therefore
// cap the WHOLE request, not just each file, safely below that limit.
const MAX_REQUEST_BYTES = 4 * 1024 * 1024 + 256 * 1024; // 4.25 MB: images + multipart overhead
const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024; // 4MB per image

function fileFilter(_req, file, cb) {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        return cb(new Error('Only JPG, PNG, WEBP, or GIF images are allowed.'));
    }
    cb(null, true);
}

function makeUploader(maxFiles) {
    return multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE_BYTES, files: maxFiles } });
}

/**
 * Rejects a multipart request whose declared size is above the cap BEFORE it is buffered.
 * (Browsers always send Content-Length for form uploads; Vercel enforces its own limit as well.)
 */
function limitRequestBytes(maxBytes = MAX_REQUEST_BYTES) {
    return (req, res, next) => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
            return res.status(413).json({
                message: 'These images are too large to send through the server (4 MB per request). Use smaller images, or upload them one at a time.',
            });
        }
        next();
    };
}

module.exports = {
    // each endpoint has its OWN file-count limit
    uploadSingle: makeUploader(1), // POST /api/upload          (product main image)
    uploadGallery: makeUploader(6), // POST /api/upload/multiple (product gallery)
    uploadReview: makeUploader(4), // POST /api/upload/review   (review photos)
    limitRequestBytes,
    MAX_REQUEST_BYTES,
    MAX_FILE_SIZE_BYTES,
};
