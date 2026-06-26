/**
 * config/cloudinary.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralised Cloudinary setup + a helper that uploads an in-memory file buffer
 * (from multer memoryStorage) to Cloudinary and returns the file metadata.
 *
 * REQUIRED ENV VARS (set these in Render → Environment, NOT in code):
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 *
 * INSTALL:  npm install cloudinary
 */

const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a single in-memory file (multer memoryStorage gives you file.buffer)
 * to Cloudinary.
 *
 * @param {Object} file    - a multer file object ({ buffer, originalname, mimetype })
 * @param {String} folder  - Cloudinary folder to store it in (e.g. "leave-documents")
 * @returns {Promise<{ name, url, type }>} - shape matches the Leave.documents schema
 *
 * resource_type "auto" is important: it lets Cloudinary accept PDFs / DOCX (raw)
 * as well as images. Without it, non-image uploads fail.
 */
const uploadBufferToCloudinary = (file, folder = "leave-documents") =>
  new Promise((resolve, reject) => {
    if (!file || !file.buffer) {
      return reject(new Error("No file buffer provided"));
    }

    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "auto",
        // keep the original filename (sans extension) as the public_id prefix
        use_filename: true,
        unique_filename: true,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          name: file.originalname,
          url:  result.secure_url,
          type: file.mimetype,
        });
      }
    );

    stream.end(file.buffer);
  });

module.exports = { cloudinary, uploadBufferToCloudinary };