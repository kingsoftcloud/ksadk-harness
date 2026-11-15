// Durable image references only; URLs and bytes are supplied by the host's
// session-authorized loader, never recovered from model text or filesystem paths.
export function userImages(values) {
  return (Array.isArray(values) ? values : []).slice(0, 32).flatMap(value => {
    const image = value?.attachment ?? value;
    if (!image || typeof image.attachmentId !== 'string' || !/^(?:sha256:)?[\w-]{1,256}$/.test(image.attachmentId)
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mediaType)
      || ![image.bytes, image.width, image.height].every(n => Number.isSafeInteger(n) && n > 0)) return [];
    return [{ attachment: { attachmentId: image.attachmentId, mediaType: image.mediaType,
      bytes: image.bytes, width: image.width, height: image.height,
      ...(typeof image.name === 'string' ? { name: image.name.slice(0, 256) } : {}) } }];
  });
}

export function imagePreviewUrl(value) {
  return typeof value === 'string' && /^(blob:|data:image\/(?:png|jpeg|webp|gif);base64,|https?:\/\/)/i.test(value) ? value : null;
}
