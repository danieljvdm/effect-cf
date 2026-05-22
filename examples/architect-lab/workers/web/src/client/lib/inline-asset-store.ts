import type { TLAsset, TLAssetStore } from "tldraw";

export const inlineAssetStore: TLAssetStore = {
  async upload(_asset: TLAsset, file: File) {
    return {
      src: await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") {
            resolve(reader.result);
            return;
          }
          reject(new Error("Unable to read asset as data URL"));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      }),
    };
  },
  resolve(asset) {
    return asset.props.src;
  },
};
