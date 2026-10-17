{
  stdenvNoCC,
  nodejs,
  makeWrapper,
  python3,
  esbuild,
}:

stdenvNoCC.mkDerivation {
  pname = "typellm";
  version = "1.0.0";
  src = ./.;
  nativeBuildInputs = [ nodejs makeWrapper ];

  passthru.workerESM = stdenvNoCC.mkDerivation {
    pname = "typellm-worker-esm";
    version = "1.0.0";
    src = ./.;
    nativeBuildInputs = [ python3 esbuild ];
    dontBuild = true;
    installPhase = ''
      esbuild src/typellm.mjs --bundle --format=esm --platform=neutral --target=es2022 --outfile="$TMPDIR/typellm.mjs" --log-level=error
      python3 ${../../tools/jev-provider-artifact.py} --provider typellm selftest --source "$TMPDIR/typellm.mjs"
      python3 ${../../tools/jev-provider-artifact.py} --provider typellm assemble --source "$TMPDIR/typellm.mjs" --out "$out"
    '';
  };

  installPhase = ''
    mkdir -p "$out/lib" "$out/share/typellm" "$out/bin"
    cp -r src cli package.json "$out/lib/"
    cp artifact.jsonl "$out/share/typellm/artifact.jsonl"
    makeWrapper ${nodejs}/bin/node "$out/bin/typellm" \
      --add-flags "$out/lib/cli/index.mjs"
  '';
}
