const assert=require('node:assert/strict');
const ts=require('typescript');
let functions;
let declarations;
module.exports=function panelFunction(name) {
  if(!functions) {
    const html=require('../../dist/ui/PanelHtml').renderPanelHtml();
    const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
    const script=scripts.sort((a,b)=>b.length-a.length)[0];assert.ok(script,'rendered panel script missing');
    const ast=ts.createSourceFile('rendered-panel.js',script,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    functions=new Map(); declarations=new Map();
    const visit=node=>{
      if(ts.isFunctionDeclaration(node)&&node.name)functions.set(node.name.text,node.getText(ast));
      if(ts.isVariableStatement(node)) for(const declaration of node.declarationList.declarations)
        if(ts.isIdentifier(declaration.name))declarations.set(declaration.name.text,node.getText(ast));
      ts.forEachChild(node,visit);
    };
    visit(ast);
  }
  assert.ok(functions.has(name),'rendered production function missing: '+name);
  return functions.get(name);
};

// Return an exact rendered declaration only when explicitly requested by a fixture.
module.exports.declaration=function(name){
  if(!declarations)module.exports('asArray');
  assert.ok(declarations.has(name),'rendered declaration missing: '+name);
  return declarations.get(name);
};
