{ pkgs }:
# Supply pkgs from root flake.lock's root.inputs.nixpkgs, not another lock node.
# Run ghalet AND every management command inside this same environment/config.
pkgs.buildFHSEnv {
  name = "ops-ghalet-host";
  targetPkgs = p: with p; [
    bash coreutils git gh nodejs curl cacert zlib openssl icu libunwind util-linux
  ];
  runScript = "bash";
}
