const travelImageCatalog={"/static/assets/alps.jpg":{"640":"/static/optimized/alps-1c7f72cc3e17dfca-640.webp","1280":"/static/optimized/alps-1c7f72cc3e17dfca-1280.webp","320":"/static/optimized/alps-1c7f72cc3e17dfca-320.webp","480":"/static/optimized/alps-1c7f72cc3e17dfca-480.webp"},"/static/assets/italy.jpg":{"640":"/static/optimized/italy-7734441f40374564-640.webp","1280":"/static/optimized/italy-7734441f40374564-1280.webp","320":"/static/optimized/italy-7734441f40374564-320.webp","480":"/static/optimized/italy-7734441f40374564-480.webp"},"/static/assets/kyoto.jpg":{"640":"/static/optimized/kyoto-6710bd424184816d-640.webp","1280":"/static/optimized/kyoto-6710bd424184816d-1280.webp","320":"/static/optimized/kyoto-6710bd424184816d-320.webp","480":"/static/optimized/kyoto-6710bd424184816d-480.webp"},"/static/assets/lake.jpg":{"640":"/static/optimized/lake-2942c33904cd0852-640.webp","1280":"/static/optimized/lake-2942c33904cd0852-1280.webp","320":"/static/optimized/lake-2942c33904cd0852-320.webp","480":"/static/optimized/lake-2942c33904cd0852-480.webp"},"/static/assets/mountain.jpg":{"640":"/static/optimized/mountain-36978fc5830c6515-640.webp","1280":"/static/optimized/mountain-36978fc5830c6515-1280.webp","320":"/static/optimized/mountain-36978fc5830c6515-320.webp","480":"/static/optimized/mountain-36978fc5830c6515-480.webp"}};
function travelImageUrl(url,width=640){if(travelImageCatalog[url])return travelImageCatalog[url][width];if(/^\/media\/[a-f0-9]{32}\.webp$/.test(url))return url+'?w='+width;return url;}

// Select by rendered dimensions and pixel density; keep non-image URLs intact.
function travelDisplayImageUrl(source,img){
 const url=new URL(source,location.origin),rect=img.getBoundingClientRect();
 if(url.origin!==location.origin||!rect.width)return source;
 const needed=Math.ceil(Math.max(rect.width,rect.height)*(window.devicePixelRatio||1));
 const width=[320,480,640,1280].find(size=>size>=needed)||1280;
 if(/^\/media\/[a-f0-9]{32}\.webp$/.test(url.pathname)){
  const limit=Number(url.searchParams.get('w'));
  url.searchParams.set('w',[320,480,640,1280].includes(limit)?Math.min(width,limit):width);return url.href;
 }
 for(const [original,variants]of Object.entries(travelImageCatalog)){
  if(url.pathname===original)return variants[width];
  const current=Object.entries(variants).find(([,path])=>url.pathname===path);
  if(current)return variants[Math.min(width,Number(current[0]))];
 }
 return source;
}
