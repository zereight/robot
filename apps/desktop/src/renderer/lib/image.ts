/** Reads a picture file and returns a square PNG data URL, cropped to cover. */
export const squarePicture = (file: File, size = 256): Promise<string> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement("canvas")
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext("2d")
      if (!ctx) return reject(new Error("no canvas"))
      const side = Math.min(img.naturalWidth, img.naturalHeight)
      const sx = (img.naturalWidth - side) / 2
      const sy = (img.naturalHeight - side) / 2
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL("image/png"))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("not a picture"))
    }
    img.src = url
  })
