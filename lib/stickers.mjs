import sharp from "sharp";

export async function createSticker(imageBuffer) {
  const qualities = [82, 76, 70, 64, 58, 52, 46, 40, 34, 28];

  for (const quality of qualities) {
    const result = await sharp(imageBuffer, {
      failOn: "warning",
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .resize(512, 512, {
        fit: "contain",
        position: "center",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality, alphaQuality: 80, effort: 6 })
      .toBuffer();

    if (result.length <= 100 * 1024) {
      return result;
    }
  }

  const error = new Error("No se pudo comprimir la imagen por debajo de 100 KB.");
  error.code = "STICKER_TOO_LARGE";
  throw error;
}
