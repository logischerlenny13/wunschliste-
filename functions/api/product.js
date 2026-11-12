const AMAZON_SUFFIXES = [
  "amazon.de","amazon.com","amazon.co.uk","amazon.fr","amazon.it","amazon.es",
  "amazon.nl","amazon.pl","amazon.se","amazon.com.be","amazon.co.jp","amazon.ca",
  "amazon.com.au","amazon.in","amazon.com.mx","amazon.com.br","amazon.sg",
  "amazon.ae","amazon.sa","amazon.com.tr"
];
const SHORT_HOSTS = new Set(["amzn.eu","amzn.to","a.co"]);
function allowedAmazonHost(host) {
  return SHORT_HOSTS.has(host) || AMAZON_SUFFIXES.some(domain => host === domain || host.endsWith("." + domain));
}
function decodeHtml(value) {
  return String(value || "").replace(/&quot;|&#34;/gi,'"').replace(/&#39;|&apos;/gi,"'")
    .replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">")
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)))
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
}
function cleanText(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g," ").replace(/\\s+/g," ")).trim();
}
function attr(tag, name) {
  const re = new RegExp("(?:^|\\s)" + name.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\$&") + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))","i");
  const m = tag.match(re);
  return decodeHtml(m ? (m[1] ?? m[2] ?? m[3] ?? "") : "");
}
function collectProductImages(node, out) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(x=>collectProductImages(x,out)); return; }
  if (typeof node !== "object") return;
  const types = [].concat(node["@type"] || []).map(x=>String(x).toLowerCase());
  if (types.includes("product")) {
    const values = [].concat(node.image || []);
    for (const v of values) {
      if (typeof v === "string") out.push(v);
      else if (v && typeof v === "object") out.push(v.url || v.contentUrl || "");
    }
  }
  for (const key of ["@graph","mainEntity","itemListElement"]) if (node[key]) collectProductImages(node[key],out);
}
function validImage(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    const host = u.hostname.toLowerCase();
    if (!(host.endsWith("media-amazon.com") || host.endsWith("images-amazon.com") || host.endsWith("ssl-images-amazon.com"))) return "";
    if (/\\b(logo|icon|sprite|pixel|transparent|placeholder)\\b/i.test(u.pathname)) return "";
    if (/\\.(svg|gif)(?:$|[?#])/i.test(u.href)) return "";
    return u.href;
  } catch { return ""; }
}
function meta(html, key, attrName="property") {
  const tags = html.match(/<meta\\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (attr(tag,attrName).toLowerCase() === key.toLowerCase()) {
      const value = attr(tag,"content");
      if (value) return value;
    }
  }
  return "";
}
function parseAmazon(html, finalUrl) {
  const title = cleanText(
    (html.match(/<span[^>]*id=["']productTitle["'][^>]*>([\\s\\S]*?)<\\/span>/i) || [])[1] ||
    meta(html,"og:title") || (html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i) || [])[1]
  ).slice(0,180);
  const desc = cleanText(meta(html,"og:description") || meta(html,"description","name")).slice(0,600);
  const bullets = [];
  const bulletArea = (html.match(/id=["']feature-bullets["'][^>]*>([\\s\\S]*?)(?:<\\/ul>|<\\/div>)/i) || [])[1] || "";
  for (const m of bulletArea.matchAll(/<span[^>]*class=["'][^"']*a-list-item[^"']*["'][^>]*>([\\s\\S]*?)<\\/span>/gi)) {
    const t=cleanText(m[1]); if(t.length>8 && !bullets.includes(t)) bullets.push(t.slice(0,300));
  }
  const candidates=[];
  const push = value => {
    for (const v of [].concat(value || [])) {
      const u=validImage(typeof v==="string"?v:(v?.url||v?.contentUrl||""));
      if(u)candidates.push(u);
    }
  };
  const scripts = html.match(/<script[^>]*type=["']application\\/ld\\+json["'][^>]*>[\\s\\S]*?<\\/script>/gi) || [];
  for (const script of scripts) {
    const raw=(script.match(/>([\\s\\S]*?)<\\/script>/i)||[])[1];
    if(raw)try{collectProductImages(JSON.parse(decodeHtml(raw)),candidates)}catch{}
  }
  for (const tag of html.match(/<img\\b[^>]*>/gi) || []) {
    const dynamic=attr(tag,"data-a-dynamic-image");
    if(dynamic)try{push(Object.keys(JSON.parse(dynamic)))}catch{}
    push(attr(tag,"data-old-hires"));
    push(attr(tag,"data-src"));
    push(attr(tag,"src"));
  }
  push(meta(html,"og:image"));
  const images=[...new Set(candidates)].slice(0,8);
  return {title,desc,bullets:bullets.slice(0,8),imgs:images,url:finalUrl};
}
export async function onRequestGet({request}) {
  const cors={"Access-Control-Allow-Origin":"*","Content-Type":"application/json; charset=utf-8","Cache-Control":"public, max-age=300"};
  const send=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:cors});
  try {
    const incoming=new URL(request.url);
    const raw=incoming.searchParams.get("url");
    if(!raw)return send({ok:false,code:"MISSING_URL",message:"Es fehlt ein Produktlink."},400);
    let target;
    try{target=new URL(raw)}catch{return send({ok:false,code:"INVALID_URL",message:"Der Produktlink ist ungültig."},400)}
    if(!allowedAmazonHost(target.hostname.toLowerCase()))return send({ok:false,code:"NOT_AMAZON",message:"Das ist kein unterstützter Amazon-Link."},400);
    const response=await fetch(target.href,{redirect:"follow",headers:{
      "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language":"de-DE,de;q=0.9,en;q=0.7"
    }});
    const finalUrl=new URL(response.url);
    if(!allowedAmazonHost(finalUrl.hostname.toLowerCase()))return send({ok:false,code:"REDIRECT_BLOCKED",message:"Amazon hat auf eine nicht unterstützte Adresse weitergeleitet."},502);
    if(!response.ok)return send({ok:false,code:response.status===403||response.status===503?"AMAZON_BLOCKED":"HTTP_"+response.status,
      message:response.status===403||response.status===503?"Amazon hat den automatisierten Abruf blockiert. Bitte versuche es später erneut.":"Amazon antwortet gerade mit HTTP "+response.status+"."},502);
    const html=await response.text();
    if(/captcha|robot check|validatecaptcha|sorry, we just need to make sure/i.test(html.slice(0,250000)))return send({ok:false,code:"AMAZON_BLOCKED",message:"Amazon zeigt eine Bot-Prüfung. Der kostenlose Abruf ist deshalb gerade nicht möglich."},503);
    const result=parseAmazon(html,finalUrl.href);
    if(!result.title && !result.imgs.length)return send({ok:false,code:"NO_PRODUCT_DATA",message:"Amazon hat keine auslesbaren Produktdaten geliefert."},422);
    return send({ok:true,data:result});
  } catch(error) {
    return send({ok:false,code:"FETCH_FAILED",message:"Der kostenlose Amazon-Abruf ist fehlgeschlagen. Bitte versuche es später erneut."},502);
  }
}
