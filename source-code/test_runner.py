import sys
import subprocess

def main():
    print('Executing ARINC767Forge Pro Test Runner...')
    res = subprocess.run([sys.executable, '/working_dir/c_eac9211e591f9798/arinc767-forge-pro/source-code/arinc767-cli.py', '--test'], capture_output=True, text=True)
    print(res.stdout)
    if res.returncode != 0:
        print('STDERR:', res.stderr)
        sys.exit(1)
    print('Test Runner Completed Successfully!')

if __name__ == '__main__':
    main()
