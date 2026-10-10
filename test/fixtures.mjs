import { PDFDocument, PDFName, PDFNumber, PDFString, PDFRawStream, StandardFonts, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from 'pdf-lib';
import pako from 'pako';

export async function fixture({ pages = 2, dimension = 1024, name = 'Crisp PDF', transparent = false, predictor = false, cmyk = false } = {}) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
    const page = doc.addPage([900,700]);
    page.drawRectangle({ x:0,y:0,width:900,height:700,color:rgb(.98,.98,.98) });
    page.drawText(`${name} / page ${pageIndex+1}`, { x:54,y:632,size:26,font,color:rgb(.08,.1,.15) });
    page.drawText('Text stays sharp at every zoom level.', {x:54,y:594,size:16,font,color:rgb(.2,.2,.2)});
    const raw = new Uint8Array(dimension*dimension*3); let random = 711 + pageIndex*300;
    for(let y=0;y<dimension;y++) for(let x=0;x<dimension;x++) {
      random = (Math.imul(random,1664525)+1013904223)>>>0;
      const i=(y*dimension+x)*3, noise=((random>>>24)%31)-15;
      raw[i]=Math.max(0,Math.min(255,40+180*x/dimension+noise)); raw[i+1]=Math.max(0,Math.min(255,45+170*y/dimension+noise)); raw[i+2]=Math.max(0,Math.min(255,160+70*Math.sin(x/80)+noise));
    }
    let pixels = raw, parms;
    if (predictor) {
      const row = dimension*3; pixels = new Uint8Array((row+1)*dimension);
      for(let y=0;y<dimension;y++) { pixels[y*(row+1)]=1; for(let x=0;x<row;x++) pixels[y*(row+1)+x+1]=(raw[y*row+x]-(x>=3?raw[y*row+x-3]:0))&255; }
      pixels=pako.deflate(pixels); parms={Predictor:15,Colors:3,BitsPerComponent:8,Columns:dimension};
    }
    let mask;
    if(transparent) {
      const alpha=new Uint8Array(dimension*dimension); for(let y=0;y<dimension;y++)for(let x=0;x<dimension;x++)alpha[y*dimension+x]=Math.round(255*x/dimension);
      mask=doc.context.register(PDFRawStream.of(doc.context.obj({Type:'XObject',Subtype:'Image',Width:dimension,Height:dimension,ColorSpace:'DeviceGray',BitsPerComponent:8,Filter:'FlateDecode'}),pako.deflate(alpha)));
      page.drawRectangle({x:54,y:245,width:480,height:280,color:rgb(.2,.7,.8)});
    }
    const dict=doc.context.obj({Type:'XObject',Subtype:'Image',Width:dimension,Height:dimension,ColorSpace:'DeviceRGB',BitsPerComponent:8, ...(predictor?{Filter:'FlateDecode',DecodeParms:parms}:{}), ...(mask?{SMask:mask}:{})});
    const ref=doc.context.register(PDFRawStream.of(dict,pixels));
    page.node.setXObject(PDFName.of('Photo'),ref);
    page.pushOperators(pushGraphicsState(),concatTransformationMatrix(480,0,0,280,54,245),drawObject('Photo'),popGraphicsState());
    page.drawRectangle({x:580,y:245,width:240,height:280,color:rgb(.85,.92,1),borderColor:rgb(.2,.4,.7),borderWidth:2});
    page.drawText('Vector graphics', {x:600,y:445,size:20,font});
    page.drawText('Readable text\nComfortable spacing\nTransparent artwork', {x:600,y:400,size:14,lineHeight:24,font});
    page.drawText('Visit example.com', {x:54,y:160,size:14,font,color:rgb(.05,.3,.7)});
    page.node.set(PDFName.of('Annots'),doc.context.obj([doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Link',Rect:[54,155,210,177],Border:[0,0,0],A:{S:'URI',URI:PDFString.of('https://example.com')}}))]));
    if(cmyk) {
      const data=new Uint8Array(64*64*4);for(let i=0;i<data.length;i+=4){data[i]=120;data[i+1]=30;data[i+2]=0;data[i+3]=0;}
      const r=doc.context.register(PDFRawStream.of(doc.context.obj({Type:'XObject',Subtype:'Image',Width:64,Height:64,ColorSpace:'DeviceCMYK',BitsPerComponent:8,Filter:'FlateDecode'}),pako.deflate(data)));
      page.node.setXObject(PDFName.of('CMYK'),r);page.pushOperators(pushGraphicsState(),concatTransformationMatrix(120,0,0,32,600,190),drawObject('CMYK'),popGraphicsState());
    }
  }
  return doc.save({useObjectStreams:false});
}
export async function signedFixture() {
  const doc=await PDFDocument.load(await fixture({pages:1,dimension:32}));
  doc.catalog.set(PDFName.of('TestSignature'),doc.context.register(doc.context.obj({Type:'Sig',ByteRange:[0,1,2,3],Contents:PDFString.of('placeholder')})));
  return doc.save();
}
export async function duplicateFixture() {
  const doc=await PDFDocument.create();
  const raw=new Uint8Array(512*512*3).fill(180);
  for(let i=0;i<3;i++) {
    const page=doc.addPage([600,600]);
    const ref=doc.context.register(PDFRawStream.of(doc.context.obj({Type:'XObject',Subtype:'Image',Width:512,Height:512,ColorSpace:'DeviceRGB',BitsPerComponent:8}),raw.slice()));
    page.node.setXObject(PDFName.of('Same'),ref);page.pushOperators(pushGraphicsState(),concatTransformationMatrix(400,0,0,400,40,40),drawObject('Same'),popGraphicsState());
  }
  return doc.save({useObjectStreams:false});
}
