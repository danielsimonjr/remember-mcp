"""Setup script for remember-mcp"""
from setuptools import setup, find_packages

with open("README.md", "r", encoding="utf-8") as fh:
    long_description = fh.read()

setup(
    name="remember-mcp",
    version="1.0.0",
    author="Daniel Simon Jr",
    author_email="",
    description="Hybrid long-term memory combining OpenMemory (cognitive) with memvid (video archival)",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/danielsimonjr/remember-mcp",
    packages=find_packages(),
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
    ],
    python_requires=">=3.8",
    install_requires=[
        "numpy>=1.24.0",
        "sentence-transformers>=2.2.2",
        "mcp>=0.9.0",
        "python-dotenv>=1.0.0",
        "openmemory-python>=1.0.0",
        "schedule>=1.2.0",
        # Note: memvid must be installed from GitHub fork for numpy 2.x support
        # pip install git+https://github.com/danielsimonjr/memvid.git@main
    ],
    entry_points={
        "console_scripts": [
            "remember-server=remember.mcp.server:main",
        ],
    },
)
