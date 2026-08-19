; Inno Setup script for the Fieldscope Windows installer.
;
; Compiled by the release workflow on windows-latest:
;   ISCC.exe /DMyAppVersion=0.1.0 packaging\windows\fieldscope.iss
;
; It packages a staging\ folder (built by the workflow) that already contains the
; bundled Node runtime (node.exe), the server + production node_modules, and the
; built client — so the installed app needs nothing else on the machine. Installs
; per-user by default (no admin needed — friendly to locked-down OT laptops),
; with Start Menu + optional Desktop shortcuts and an uninstaller.

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#define MyAppName "Fieldscope"
#define MyAppPublisher "Connected Core Industries"
#define MyAppURL "https://github.com/zbest1000/fieldscope"
#define MyAppLauncher "fieldscope-launch.cmd"

[Setup]
AppId={{4F1E1D5C-0FED-4C0F-9E00-F1E1D5C0FE01}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={autopf}\Fieldscope
DefaultGroupName=Fieldscope
DisableProgramGroupPage=yes
LicenseFile=staging\LICENSE
UninstallDisplayIcon={app}\node.exe
UninstallDisplayName={#MyAppName} {#MyAppVersion}
OutputDir=dist-installer
OutputBaseFilename=Fieldscope-Setup-{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "staging\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppLauncher}"; WorkingDir: "{app}"; IconFilename: "{app}\node.exe"; Comment: "Start the Fieldscope workbench"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppLauncher}"; WorkingDir: "{app}"; IconFilename: "{app}\node.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppLauncher}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Evidence lives outside {app} (in %LOCALAPPDATA%\Fieldscope) and is deliberately
; left in place on uninstall so a reinstall keeps the operator's captures.
Type: filesandordirs; Name: "{app}\server\node_modules\.cache"
