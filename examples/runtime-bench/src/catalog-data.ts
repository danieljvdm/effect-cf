export const products = [
  { sku: "NOTE-A5", name: "A5 dotted notebook", category: "paper", unitPriceCents: 1295 },
  { sku: "PEN-BLK", name: "Black gel pen pack", category: "writing", unitPriceCents: 895 },
  { sku: "PENCIL-HB", name: "HB pencil set", category: "writing", unitPriceCents: 650 },
  { sku: "PAD-A4", name: "A4 writing pad", category: "paper", unitPriceCents: 795 },
  { sku: "FOLDER-5", name: "Document folder pack", category: "filing", unitPriceCents: 1195 },
  { sku: "CLIP-BOX", name: "Binder clip assortment", category: "filing", unitPriceCents: 575 },
  { sku: "DESK-MAT", name: "Recycled desk mat", category: "desk", unitPriceCents: 2495 },
  { sku: "CABLE-USB", name: "USB-C charging cable", category: "technology", unitPriceCents: 1595 },
  { sku: "MOUSE-WL", name: "Wireless mouse", category: "technology", unitPriceCents: 3295 },
  { sku: "STAND-LP", name: "Laptop stand", category: "technology", unitPriceCents: 4495 },
  { sku: "BOTTLE-600", name: "600ml reusable bottle", category: "desk", unitPriceCents: 2295 },
  { sku: "LABEL-100", name: "Address label sheets", category: "paper", unitPriceCents: 995 },
] as const;

export type Product = (typeof products)[number];
