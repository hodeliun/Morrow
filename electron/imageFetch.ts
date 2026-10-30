// cap the body while reading; content-length alone does not bound a chunked response
export async function readBoundedImage(
  response: Response,
  limit: number,
): Promise<{ type: string; data: ArrayBuffer } | null> {
  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!response.ok || !type.startsWith('image/') || !response.body) {
    await response.body?.cancel();
    return null;
  }
  if (Number(response.headers.get('content-length') ?? 0) > limit) {
    await response.body.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - size) {
        await reader.cancel();
        return null;
      }
      size += value.byteLength;
      chunks.push(value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { type, data: data.buffer };
  } finally {
    reader.releaseLock();
  }
}
