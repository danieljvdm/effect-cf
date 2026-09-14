import { Images } from "effect-cf";

export class ImageService extends Images.Tag<ImageService>()("ImageService") {}

export const bindingLayer = ImageService.layer({ binding: "IMAGES" });
