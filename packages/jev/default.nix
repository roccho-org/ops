{
  stdenvNoCC,
  nodejs,
  makeWrapper,
  python3,
  esbuild,
  typellm,
}:

stdenvNoCC.mkDerivation {
  pname = "jev";
  version = "1.0.0";

  src = ./.;

  nativeBuildInputs = [
    nodejs
    makeWrapper
  ];

  passthru.workerESM = stdenvNoCC.mkDerivation {
    pname = "jev-worker-esm";
    version = "1.0.0";
    src = ./.;
    nativeBuildInputs = [
      python3
      esbuild
    ];
    dontBuild = true;
    installPhase = ''
      esbuild src/worker.mjs --bundle --format=esm --platform=neutral --target=es2022 --outfile="$TMPDIR/jev.mjs" --log-level=error
      python3 ${../../tools/jev-provider-artifact.py} --provider jev selftest --source "$TMPDIR/jev.mjs"
      python3 ${../../tools/jev-provider-artifact.py} --provider jev assemble --source "$TMPDIR/jev.mjs" --out "$out"
      digest=$(cut -d' ' -f1 "$out/jev-provider.zip.sha256")
      python3 ${../../tools/jev-provider-artifact.py} --provider jev verify --archive "$out/jev-provider.zip" --sha256 "$digest"
    '';
  };

  installPhase = ''
    mkdir -p $out/lib
    cp -r src cli package.json $out/lib/

    mkdir -p $out/share/jev
    cp artifact.jsonl $out/share/jev/artifact.jsonl

    mkdir -p $out/bin
    makeWrapper ${nodejs}/bin/node $out/bin/jev \
      --add-flags "$out/lib/cli/index.mjs"
    # Existing Windows launchers build .#jev and execute bin/typellm. Keep this
    # compatibility composition; the independent Jev ESM has no TypeLLM input.
    ln -s ${typellm}/bin/typellm "$out/bin/typellm"
  '';
}
