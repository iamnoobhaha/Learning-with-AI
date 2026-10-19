import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfjs-dist must stay external on the server: in Node, pdf.js disables the
  // real Worker and instead loads its "fake worker" via a *relative*
  // `import("./pdf.worker.mjs")`. If webpack bundles pdf.js, that relative specifier
  // resolves against .next/server/vendor-chunks/ instead of node_modules and
  // every server-side extraction fails with "Setting up fake worker failed".
  // The client still bundles it (workerSrc is set explicitly in PdfThumbnails).
  serverExternalPackages: ["better-sqlite3", "pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
