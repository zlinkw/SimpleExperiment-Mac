import { jobArtifactBatchIdentity, type ArtifactTransferMember } from "./JobArtifactSyncIdentity";
export type ArtifactCopyResult = { completed: string[]; errors: string[]; files: Record<string,string>; foreignOnly: string[]; failure?: unknown };
export type PreparedArtifactCopy = {
  member: ArtifactTransferMember; files: Record<string,string>; foreignOnly: string[];
  assertCurrent(): Promise<void>; release(): void;
  requests: Array<{ source: any; destination: any; paths: string[];
    guard(paths: string[]): Promise<void>;
    transfer(paths: string[], identity: {retentionKey:string;generation:string}, jobs: number): Promise<void>;
    inventory(paths: string[]): Promise<Record<string, {sha256?:string}>> }>;
};
/** Prepare stays per job. Only compatible source/destination transports are combined. */
export async function transferPreparedArtifacts(prepared: PreparedArtifactCopy[]): Promise<ArtifactCopyResult[]> {
  const results: ArtifactCopyResult[] = prepared.map(row => ({ completed: [], errors: [], files: row.files, foreignOnly: row.foreignOnly }));
  const fail = (index: number, error: any) => { const text = String(error?.message || error); if (!results[index].errors.includes(text)) results[index].errors.push(text); results[index].failure ||= error; };
  const groups = new Map<string, Array<{index:number;request:PreparedArtifactCopy["requests"][number]}>>();
  try {
    for (const [index,row] of prepared.entries()) {
      try { await row.assertCurrent(); } catch(error) { fail(index,error); continue; }
      for (const request of row.requests) {
        const key=JSON.stringify([request.source,request.destination]);
        const group=groups.get(key);if(group)group.push({index,request});else groups.set(key,[{index,request}]);
      }
    }
    for (const group of groups.values()) {
      try { jobArtifactBatchIdentity([...new Set(group.map(row=>row.index))].map(index=>prepared[index].member)); }
      catch(error){for(const row of group)fail(row.index,error);continue;}
      const paths=[...new Set(group.flatMap(row=>row.request.paths))].sort();
      for(let offset=0;offset<paths.length;offset+=500) {
        const chunk=paths.slice(offset,offset+500), valid:typeof group=[];
        for(const row of group) if(!results[row.index].errors.length) {
          try { await prepared[row.index].assertCurrent();await row.request.guard(row.request.paths.filter(file=>chunk.includes(file)));valid.push(row); }
          catch(error){fail(row.index,error);}
        }
        const active=valid.filter(row=>row.request.paths.some(file=>chunk.includes(file)));
        const batch=chunk.filter(file=>active.some(row=>row.request.paths.includes(file)));
        if(!batch.length)continue;
        try {
          const indexes=[...new Set(valid.map(row=>row.index))];
          const identity=jobArtifactBatchIdentity(indexes.map(index=>prepared[index].member));
          await active[0].request.transfer(batch,identity,indexes.length);
          const checked=await active[0].request.inventory(batch);
          for(const row of active) for(const file of batch.filter(file=>row.request.paths.includes(file))) {
            if(checked[file]?.sha256?.toLowerCase()!==prepared[row.index].files[file]?.toLowerCase())fail(row.index,Error("文件内容与本次最新产物不符："+file));
            else results[row.index].completed.push(file);
          }
        } catch(error){for(const row of active)fail(row.index,error);}
      }
    }
    for(const [index,row]of prepared.entries())try{await row.assertCurrent();}catch(error){fail(index,error);}
    return results;
  } finally { for(const row of prepared)row.release(); }
}
