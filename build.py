#!/usr/bin/env python3
"""Build a signed offline APK using the official Android SDK and JDK 17."""
from pathlib import Path
import subprocess, os, secrets, zipfile, hashlib, json, xml.etree.ElementTree as ET, re
P=Path(__file__).resolve().parent
os.chdir(P)
manifest=ET.parse(P/'app/AndroidManifest.xml').getroot()
version=manifest.get('{http://schemas.android.com/apk/res/android}versionName')
assert re.fullmatch(r'[0-9]+(?:\.[0-9]+)*',version), 'Invalid version'
sdk=Path(os.environ.get('ANDROID_SDK_ROOT', os.environ.get('ANDROID_HOME', r'C:\Android\Sdk')))
bt=sdk/'build-tools'/'35.0.0'; android=sdk/'platforms'/'android-35'/'android.jar'; out=P/'build'/version;out.mkdir(parents=True,exist_ok=True)
resource_flat=out/'resources.zip'
def run(*args,**kw):
    command=[str(a) for a in args]
    if os.name=='nt' and not Path(command[0]).suffix:
        if Path(command[0]+'.exe').exists(): command[0]+='.exe'
        elif Path(command[0]+'.bat').exists(): command[0]+='.bat'
    subprocess.run(command,check=True,**kw)
unit_tests=sorted((P/'tests').glob('*.test.cjs'))
unit_tests=[f for f in unit_tests if 'ui' not in f.name]
if unit_tests: run('node','--test',*unit_tests)
run(bt/'aapt2','compile','--dir','app/res','-o',resource_flat)
run(bt/'aapt2','link','-o',out/'unsigned.apk','-I',android,'--manifest','app/AndroidManifest.xml','-A','app/assets','-R',resource_flat)
classes=out/'classes'; classes.mkdir(exist_ok=True)
run('javac','--release','8','-encoding','UTF-8','-classpath',android,'-d',classes,*sorted((P/'app/src').rglob('*.java')))
run('jar','cf',out/'classes.jar','-C',classes,'.')
run(bt/'d8','--release','--min-api','26','--lib',android,'--output',out,out/'classes.jar')
with zipfile.ZipFile(out/'unsigned.apk','a',compression=zipfile.ZIP_DEFLATED) as z:
    for f in out.glob('classes*.dex'): z.write(f,f.name)
run(bt/'zipalign','-f','4',out/'unsigned.apk',out/'aligned.apk')
keydir=P/'private';keydir.mkdir(mode=0o700,exist_ok=True)
passwordfile=keydir/'signing-password';keystore=keydir/'release.p12'
if (P/'dist/MechanicCheck-1.0.apk').exists():
    assert passwordfile.exists() and keystore.exists(), 'Original signing key required for update; refusing to generate replacement'
if not passwordfile.exists():
    fd=os.open(passwordfile,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:f.write(secrets.token_urlsafe(32))
env=os.environ.copy();env['APK_KEY_PASSWORD']=passwordfile.read_text().strip()
if not keystore.exists():
    run('keytool','-genkeypair','-keystore',keystore,'-storetype','PKCS12','-alias','shift-calendar','-keyalg','RSA','-keysize','3072','-validity','10000','-dname','CN=My Schedule, OU=Personal Apps','-storepass:env','APK_KEY_PASSWORD',env=env)
    keystore.chmod(0o600)
(P/'dist').mkdir(exist_ok=True)
apk=P/('dist/MechanicCheck-'+version+'.apk')
run(bt/'apksigner','sign','--ks',keystore,'--ks-key-alias','shift-calendar','--ks-pass','env:APK_KEY_PASSWORD','--out',apk,out/'aligned.apk',env=env)
run(bt/'apksigner','verify','--verbose',apk)
run(bt/'zipalign','-c','-v','4',apk)
run(bt/'aapt2','dump','badging',apk)
report={'file':apk.name,'bytes':apk.stat().st_size,'sha256':hashlib.sha256(apk.read_bytes()).hexdigest()}
(P/('dist/build-info-'+version+'.json')).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
