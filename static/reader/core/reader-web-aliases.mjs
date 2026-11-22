// Exact historical Web derivative paths. Stable IDs follow future upgrades.
const oldWebIds = new Map([
  ["htm/290c8436512bf69d5bfa5168ee9d1bd3c661813fb713a285d51f6d9c79ac2eb1", "0d6pma76snnje"],
  ["htm/caeb0dba4139520f84e6a415d5e6225fd5c4f08c67f334dd3a582773e704f402", "13gsm45m6a84e"],
  ["html/059d59132c90b7cfbce62f623f7156d3c9ab84f824ba02ee9d5b2515c90f45ec", "333czx8aps6ta"],
  ["html/277ff3413f442ae2877b3605361b3ff497f39e11ccb4088a3e38d5ae09654b7f", "3ll2arovwv1uu"],
  ["html/29cd21442cbada9c51921d96c0aa73cba00e45060045251beacc3b94340cef4e", "15ypor571rhso"],
  ["html/4c212cc38a23035684e551b07be491d99c2a301c1a6474047a700913e74a131b", "1mtnt4g5l3akf"],
  ["html/58618b50972784d4f0e8fa2b37a57f5bcb67654d4137fe0d5791e88067bc4f88", "2n3sd1elb8qnh"],
  ["html/df891e73c59f662be56c03b24d99c02d256177b592b848128ffc143bcbe42af2", "02c74lgb6a83x"],
  ["html/e909cbd489f24dd476e33ca9c403bd8d9337652bab8bff057e546bb204dda95e", "1svuo8gthbni4"],
  ["mht/0b2fa983ecaef48932bc676f99285a48b63166e182896ec8027fa96a28754a75", "1msnix87qzwcb"],
  ["mht/7d1b2ea8999ae052d537f9f92a28329d10ec3537ff9282222ac7c3485494b83b", "28f50a563fl74"],
]);

/** @param {string} raw */
export function readerWebAliasId(raw) {
  try {
    const space = "https://voiceofml-search.hf.space";
    const url = new URL(raw, space);
    if (url.username || url.password) return "";
    let path = "";
    if (url.origin === space && url.pathname === "/api/reader-bucket-resource") {
      if (url.searchParams.size !== 1) return "";
      path = url.searchParams.get("path") || "";
    } else if (url.origin === "https://huggingface.co" && !url.search) {
      const prefix = "/buckets/vomebook/reader-assets-v2/resolve/";
      if (url.pathname.startsWith(prefix)) path = decodeURIComponent(url.pathname.slice(prefix.length));
    }
    const match = /^documents\/web\/((?:html?|mht(?:ml)?)\/[a-f0-9]{64})\/document\.html$/.exec(path);
    return oldWebIds.get(match?.[1] ?? "") || "";
  } catch (_) {
    return "";
  }
}
