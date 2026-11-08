export type BuildSource = {repository:string;commit:string;path:string};
export type BuiltImage = {imageDigest:string;config:string;source:string;lockfile?:string};
export type BuildResult = {status:"built";image:BuiltImage} | {status:"invalid"|"conflict"|"unavailable";reason:string};
export type EnvironmentBuilder = (id:string,input:BuildSource)=>Promise<BuildResult>;
