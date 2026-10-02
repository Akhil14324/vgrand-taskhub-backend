const multer = require('multer');
const path = require('path');
const fs = require('fs');
const stream = require('stream');
const cloudinary = require('./cloudinary');

const MAX_SIZE = parseInt(process.env.ATTACHMENT_MAX_SIZE || '10485760', 10);
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');
const UPLOAD_BASE_URL = process.env.UPLOAD_BASE_URL || '';
const USE_CLOUDINARY = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

if (!USE_CLOUDINARY && !fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = /^(image\/|audio\/|text\/|application\/(pdf|msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.|zip|json))/;

const storage = USE_CLOUDINARY
  ? multer.memoryStorage()
  : multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `todo_${Date.now()}_${Math.round(Math.random() * 1e9)}${path.extname(file.originalname || '')}`),
  });

/** multer middleware for one file under the field name "file". */
const uploadOne = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => (ALLOWED.test(file.mimetype) ? cb(null, true) : cb(new Error('That file type is not supported'), false)),
}).single('file');

const toCloudinary = (buffer, opts) => new Promise((resolve, reject) => {
  const up = cloudinary.uploader.upload_stream(opts, (err, result) => (err ? reject(err) : resolve(result)));
  const buf = new stream.PassThrough();
  buf.end(buffer);
  buf.pipe(up);
});

/** Store the uploaded file (Cloudinary or local disk) and say where it lives. */
async function storeUpload(req, folder = 'todos') {
  const file = req.file;
  const filename = (file.originalname || 'file').slice(0, 200);
  if (!USE_CLOUDINARY) {
    const base = UPLOAD_BASE_URL || `${req.protocol}://${req.get('host')}/uploads`;
    return { url: `${base}/${file.filename}`, mime: file.mimetype, filename, size: file.size };
  }
  const publicId = `${folder}/${Date.now()}_${Math.round(Math.random() * 1e9)}`;
  if (file.mimetype === 'application/pdf') {
    // Cloudinary will not deliver PDFs as files, so keep a PNG of the document.
    const r = await toCloudinary(file.buffer, { public_id: publicId, resource_type: 'image', format: 'png' });
    return { url: r.secure_url, mime: 'image/png', filename, size: file.size };
  }
  const isImage = file.mimetype.startsWith('image/');
  const ext = path.extname(file.originalname || '').replace('.', '');
  const r = await toCloudinary(file.buffer, {
    public_id: publicId,
    resource_type: isImage ? 'image' : 'raw',
    format: ext || undefined,
    ...(isImage ? { quality: 'auto', fetch_format: 'auto' } : {}),
  });
  return { url: r.secure_url, mime: file.mimetype, filename, size: file.size };
}

module.exports = { uploadOne, storeUpload, MAX_SIZE };
