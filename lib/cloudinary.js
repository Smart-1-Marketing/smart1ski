"use strict";

const crypto = require("crypto");

/* Cloudinary's signed-upload algorithm (documented, stable, unrelated to any
   SDK): take every parameter except file/api_key/signature/resource_type,
   sort by key, join as "key=value&key=value", append the API secret with no
   separator, then SHA-1 the whole string. This implementation calls the raw
   REST endpoint directly with no cloudinary SDK, so there is nothing here
   that can silently disagree with what the account actually requires. */

function isConfigured() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

function sign(params, apiSecret) {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(toSign + apiSecret).digest("hex");
}

/**
 * Upload a PDF buffer to Cloudinary and return its public URL.
 * Returns { configured:false } if no Cloudinary credentials are set — this
 * is a normal, expected state (mirrors how a missing webhook is handled),
 * not an error.
 */
async function uploadPdf(buffer, publicId) {
  if (!isConfigured()) return { configured: false, uploaded: false };

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const folder = process.env.CLOUDINARY_FOLDER || "smart1ski/reports";

  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder, public_id: publicId, timestamp, type: "upload" };
  const signature = sign(params, apiSecret);

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "application/pdf" }), `${publicId}.pdf`);
  form.append("api_key", apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  form.append("folder", folder);
  form.append("public_id", publicId);
  form.append("type", "upload");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`, {
      method: "POST",
      body: form,
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Cloudinary upload returned ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    return {
      configured: true,
      uploaded: true,
      url: data.secure_url,
      bytes: data.bytes,
      public_id: data.public_id
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { uploadPdf, isConfigured, sign };
