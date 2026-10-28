import type { Post } from "./types.ts";

export const MAX_UPLOAD_BYTES = 1_500_000;
export const MAX_UPLOAD_BODY = 2_010_000;
const invalid = () => new Error("Escolha uma foto JPG ou PNG válida.");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function dimensions(bytes: Uint8Array, mime: string): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png") {
    if (bytes.length < 57 || [137,80,78,71,13,10,26,10].some((v,i)=>bytes[i]!==v)) throw invalid();
    let offset = 8, width = 0, height = 0, data = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      if (length > bytes.length-offset-12) throw invalid();
      const type = String.fromCharCode(...bytes.subarray(offset+4,offset+8));
      if (offset === 8) {
        if (type !== "IHDR" || length !== 13) throw invalid();
        width = view.getUint32(offset+8); height = view.getUint32(offset+12);
      } else if (type === "IHDR" || type === "acTL") throw invalid();
      if (type === "IDAT" && length) data = true;
      offset += length+12;
      if (type === "IEND") {
        if (length || !data || offset !== bytes.length) throw invalid();
        return { width, height };
      }
    }
    throw invalid();
  }
  if (mime !== "image/jpeg" || bytes.length < 20 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw invalid();
  let offset = 2, width = 0, height = 0;
  while (offset+4 < bytes.length-2) {
    if (bytes[offset++] !== 255) throw invalid();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (!marker || marker === 216 || marker === 217 || (marker>=208 && marker<=215)) throw invalid();
    if (offset+2 > bytes.length-2) throw invalid();
    const length = view.getUint16(offset);
    if (length < 2 || offset+length > bytes.length-2) throw invalid();
    if (marker>=192 && marker<=207 && ![196,200,204].includes(marker)) {
      if (length<8) throw invalid();
      height=view.getUint16(offset+3);width=view.getUint16(offset+5);
    }
    if (marker===218) {
      if (!width || !height || length<6 || offset+length>=bytes.length-2) throw invalid();
      return { width, height };
    }
    offset+=length;
  }
  throw invalid();
}

/** An upload is original content, never a request to the feed, model or scheduler. */
export function manualPost(input: Record<string, unknown>, now = new Date()): { post: Post; image: ArrayBuffer } {
  if (typeof input.id !== "string" || !uuid.test(input.id)) throw new Error("Identificador do rascunho inválido.");
  if (typeof input.caption !== "string" || !input.caption.trim() || input.caption.trim().length>1800 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.caption)) throw new Error("Escreva uma legenda de até 1800 caracteres.");
  if (!input.image || typeof input.image !== "object" || Array.isArray(input.image)) throw invalid();
  const image = input.image as Record<string, unknown>;
  if (!["image/jpeg","image/png"].includes(String(image.mimeType)) || typeof image.base64 !== "string" || !image.base64.length || image.base64.length>2_000_000 || image.base64.length%4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64)) throw invalid();
  let binary: string;
  try { binary=atob(image.base64);if(btoa(binary)!==image.base64)throw invalid(); } catch { throw invalid(); }
  const bytes = new Uint8Array(binary.length);
  for (let index=0;index<binary.length;index++) bytes[index]=binary.charCodeAt(index);
  if (bytes.byteLength>MAX_UPLOAD_BYTES) throw new Error("A foto preparada deve ter até 1,5 MB.");
  const size=dimensions(bytes,String(image.mimeType));
  if (size.width<320 || size.width>1440 || size.height<150 || size.height>1920 || size.width/size.height<0.75 || size.width/size.height>1.91) throw new Error("Prepare a foto no formato do Instagram antes de salvar.");
  const id=input.id.toLowerCase(),caption=input.caption.trim(),date=now.toISOString();
  const post:Post={id,articleId:`authored:${id}`,createdAt:date,updatedAt:date,status:"draft",imageReady:true,deliveries:[],demo:false,
    uploadedImage:{mimeType:image.mimeType as "image/jpeg"|"image/png",...size},
    content:{origin:"authored",title:caption.split(/\r?\n/)[0].slice(0,88),subtitle:"",caption,takeaways:[],hashtags:[],sourceUrl:"",sourceName:"",relevance:100,reason:"",topic:"Autoral",shouldPost:true}};
  return {post,image:bytes.buffer};
}

export function mediaExtension(post: Post): "jpg" | "png" { return post.uploadedImage?.mimeType === "image/jpeg" ? "jpg" : "png"; }
