export async function collect(client) {
 const document=await client("/summary");
 return document.parts.map(part=>({id:document.lot+':'+part.serial,lot:document.lot,...part}));
}
