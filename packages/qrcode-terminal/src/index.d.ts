declare const qr: {
  generate(input: string, options: { small: boolean }, callback: (rendered: string) => void): void;
};
export = qr;
