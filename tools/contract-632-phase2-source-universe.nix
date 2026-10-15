let
  root = ../.;
  packagesDir = root + /packages;
  entries = builtins.readDir packagesDir;
  packageNames = builtins.filter (name: entries.${name} == "directory") (builtins.attrNames entries);

  selectedKeys = [
    "package"
    "packageName"
    "packageRole"
    "mission"
    "responsibility"
    "forbiddenResponsibility"
    "primaryTarget"
    "provides"
    "requires"
    "requiredOutputs"
    "requiredChecks"
    "publicInterface"
    "sourceLayout"
    "checkPackageContract"
    "productScopePurposeContribution"
    "allowedPaths"
    "forbiddenPaths"
  ];

  normalize = value:
    let
      valueType = builtins.typeOf value;
    in
    if valueType == "null" || valueType == "string" || valueType == "int" || valueType == "float" || valueType == "bool" then
      value
    else if valueType == "path" then
      toString value
    else if valueType == "list" then
      map normalize value
    else if valueType == "set" then
      builtins.mapAttrs (_: normalize) value
    else
      { __unsupportedType = valueType; };

  safeAttr = attrs: key:
    let
      attempted = builtins.tryEval (builtins.deepSeq attrs.${key} attrs.${key});
    in
    if attempted.success then normalize attempted.value else { __evaluationError = true; };

  evaluatePackage = packageId:
    let
      relativePath = "packages/${packageId}/default.nix";
      file = root + "/${relativePath}";
      exists = builtins.pathExists file;
      body = if exists then builtins.readFile file else "";
      prefixLength = if builtins.stringLength body < 256 then builtins.stringLength body else 256;
      compactPrefix = builtins.replaceStrings [ " " "\n" "\r" "\t" ] [ "" "" "" "" ] (builtins.substring 0 prefixLength body);
      looksLikeJson = exists && builtins.stringLength compactPrefix >= 2 && builtins.substring 0 2 compactPrefix == "{\"";
      sourceFormat = if !exists then "absent" else if looksLikeJson then "json" else "nix";
      attempted =
        if !exists then
          { success = false; value = null; }
        else if looksLikeJson then
          { success = true; value = builtins.fromJSON body; }
        else
          builtins.tryEval (import file);
      valueType = if attempted.success then builtins.typeOf attempted.value else if exists then "evaluation_error" else "absent";
      attrs = if valueType == "set" then attempted.value else { };
      attrNames = if valueType == "set" then builtins.attrNames attrs else [ ];
      presentKeys = builtins.filter (key: builtins.hasAttr key attrs) selectedKeys;
      metadata = builtins.listToAttrs (map (key: { name = key; value = safeAttr attrs key; }) presentKeys);
    in
    {
      inherit packageId relativePath exists sourceFormat valueType attrNames metadata;
    };
in
{
  kind = "ops.contract632.phase2LocalSourceUniverse.v1";
  authority = false;
  claimCeiling = "REPOSITORY_LOCAL_SOURCE_DISCOVERY_NOT_ORGANIZATION_MEANING";
  packages = map evaluatePackage packageNames;
}
