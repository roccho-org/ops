{ pkgs ? let
    pin = (builtins.fromJSON (builtins.readFile ../../flake.lock)).nodes.nixpkgs.locked;
  in (builtins.getFlake "github:NixOS/nixpkgs/${pin.rev}").legacyPackages.${builtins.currentSystem}
}:
pkgs.buildEnv {
  name = "event-reservoir-poc-tools";
  paths = [ pkgs.nodejs_22 pkgs.wrangler pkgs.yq-go ];
  pathsToLink = [ "/bin" ];
}
