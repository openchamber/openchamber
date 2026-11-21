declare module 'qrcode-terminal' {
  const qrcode: { generate(input: string, options: { small?: boolean }): void };
  export default qrcode;
}
