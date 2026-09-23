// Continue until empty: PostgREST may enforce a smaller page cap than requested.
export async function readAll<T>(page:(from:number,to:number)=>PromiseLike<{data:T[]|null;error:unknown}>,maximum=50_000):Promise<{data:T[];error:unknown}> {
 const data:T[]=[];
 for(;;){const result=await page(data.length,data.length+499);if(result.error)return {data:[],error:result.error};if(!result.data?.length)return {data,error:null};data.push(...result.data);if(data.length>maximum)return {data:[],error:new Error("Workspace size exceeds supported collection limit")};}
}
